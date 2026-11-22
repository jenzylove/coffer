// The .env.coffer file (format 2): an env file sealed under an epoch key, the
// epoch key sealed to every current reader (ML-KEM-1024 + X25519, keys from
// each reader's signed recipient card), and ML-DSA-87 signatures.
//
// The owner signs one "change" per change of who can read: the access block,
// the epoch, and the contents at that moment. The same signature is what the
// Coffer contract on QoreChain checks before it records the file's head, so a
// wallet (QoreX) approves exactly one message per change. A reader who later
// writes new contents signs a "write" for them.
//
// Pure: no network, no disk. Keys from chain are passed in by the caller.
import {
  EpochKeyManager, openEpochKey, sealBatch, openBatch, seal, open as openEnvelope,
  toBase64Url, fromBase64Url, isQoreSealError,
} from "@qorechain/qoreseal";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { signMessage, verifyMessage } from "@qorechain/qoresign";
import type { MessageSignature } from "@qorechain/qoresign";
import { parseAddress } from "@qorechain/qoresign";
import { sha3_256 } from "@noble/hashes/sha3.js";

export const FORMAT_VERSION = 2;
const PURPOSE_EPOCH = "coffer:epoch-key";
const PURPOSE_ADMIN = "coffer:admin";
/** Where the owner should be signing; shown in the wallet's approval text. */
export const SITE = "coffer.jdollar.site";

/** An account that signs QoreSign messages: a local key, or a wallet such as QoreX. */
export interface Signer {
  address: string;
  sign(chainId: string, data: Uint8Array): Promise<MessageSignature>;
}

/** A local signer from the account's keys (CLI, browser identity, server). */
export function localSigner(id: {
  address: string;
  classicalKey: Parameters<typeof signMessage>[0]["classicalKey"];
  pqKey: { secretKey: Uint8Array };
}): Signer {
  return {
    address: id.address,
    sign: async (chainId, data) => signMessage({ chainId, signer: id.address, data, classicalKey: id.classicalKey, pqKey: id.pqKey }),
  };
}

/** A reader to seal to: an address and the keys from its verified recipient card. */
export interface Reader {
  address: string;
  mlkemPublicKey: Uint8Array;
  x25519PublicKey: Uint8Array;
}

/**
 * The owner's signed change: who can read (access hash and the reader list,
 * in plain words), at which epoch, and the contents then. The signed text is
 * rebuilt from the file itself (changeText), so it cannot disagree with it.
 */
export interface Change {
  version: bigint;
  /** Hex SHA3-256 of the sealed data at that version. */
  data: string;
  sig: MessageSignature;
}

/** A reader's signed write of new contents under the current access block. */
export interface Write {
  note: string;
  sig: MessageSignature;
}

export interface CofferFile {
  v: number;
  /** Random 16 byte id (32 hex). The chain binds it to the owner on the first change. */
  id: string;
  chainId: string;
  name: string;
  owner: string;
  epoch: bigint;
  readers: string[];
  /** Epoch key envelope, sealed to every reader. */
  key: Uint8Array;
  /** Owner-only envelope: member keys and epoch history, so the owner can share and revoke from any machine. */
  admin: Uint8Array;
  change: Change;
  version: bigint;
  writer: string;
  /** The env file, sealed under the epoch key. */
  data: Uint8Array;
  /** Present when a reader wrote after the owner's last change. */
  write?: Write;
}

interface AdminState {
  members: Record<string, { k: string; x: string }>; // address -> base64url ML-KEM / X25519 public keys
  history: { epoch: string; key: string }[];
}

export class CofferError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CofferError";
    this.code = code;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sha3hex = (b: Uint8Array) => hex(sha3_256(b));

function context(f: Pick<CofferFile, "chainId" | "owner" | "id">) {
  return `coffer:${f.chainId}:${f.owner}:${f.id}`;
}

/** A fresh 32 hex character (16 byte) file id. */
export function newFileId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

// ---- the texts that get signed (the contract rebuilds the change text) ------

/** The access block: everything that decides who can read. Readers are sorted so order does not matter. */
export function accessBytes(f: Pick<CofferFile, "v" | "id" | "chainId" | "name" | "owner" | "epoch" | "readers" | "key" | "admin">): Uint8Array {
  return enc.encode([
    "coffer-access", String(f.v), f.id, f.chainId, f.name, f.owner, f.epoch.toString(),
    [...f.readers].sort().join(","), sha3hex(f.key), sha3hex(f.admin),
  ].join("\n"));
}

export const accessHash = (f: Parameters<typeof accessBytes>[0]) => sha3hex(accessBytes(f));
export const dataHash = (data: Uint8Array) => sha3hex(data);

/** Readers in ascending address order (the order Coffer.sol requires and prints). */
export function sortByAddress(readers: string[]): string[] {
  const key = (a: string) => hex(parseAddress(a).bytes);
  return [...new Set(readers)].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

/** 1 to 64 printable characters, no line breaks (the contract refuses anything else). */
export function checkName(name: string): string {
  const b = enc.encode(name);
  if (b.length === 0 || b.length > 64 || [...b].some((c) => c < 0x20 || c === 0x7f)) throw new CofferError("BAD_NAME", "a file name must be 1 to 64 characters on one line");
  return name;
}

/** Byte for byte the text Coffer.sol's changeText builds: what the owner reads in the wallet and signs. */
export function changeText(a: { id: string; epoch: bigint; version: bigint; access: string; data: string; name: string; readers: string[] }): string {
  return `Coffer change v1\nFile: ${a.id}\nEpoch: ${a.epoch}\nVersion: ${a.version}\nAccess: ${a.access}\nData: ${a.data}` +
    `\nName: ${a.name}\nCan open it: ${sortByAddress(a.readers).join(", ")}\nSign this only on ${SITE}.`;
}

export function writeText(a: { id: string; epoch: bigint; version: bigint; access: string; data: string; note: string }): string {
  return `Coffer write v1\nFile: ${a.id}\nEpoch: ${a.epoch}\nVersion: ${a.version}\nAccess: ${a.access}\nData: ${a.data}\n${a.note}`;
}

export function writerNote(name: string): string {
  return `Name: ${name}\nNew values written by you.\nSign this only on ${SITE}.`;
}

// ---- building ----------------------------------------------------------------

type Members = Record<string, { mlkemPublicKey: Uint8Array; x25519PublicKey: Uint8Array }>;

function sealAdmin(chainId: string, owner: { mlkemPublicKey: Uint8Array; x25519PublicKey: Uint8Array }, mgr: EpochKeyManager, members: Members): Uint8Array {
  const state: AdminState = {
    members: Object.fromEntries(Object.entries(members).map(([a, k]) => [a, { k: toBase64Url(k.mlkemPublicKey), x: toBase64Url(k.x25519PublicKey) }])),
    history: mgr.exportKeys().map((k) => ({ epoch: k.epoch.toString(), key: toBase64Url(k.key) })),
  };
  return seal({ chainId, purpose: PURPOSE_ADMIN, recipients: [owner], plaintext: enc.encode(JSON.stringify(state)), mode: "hybrid" });
}

function openAdmin(f: CofferFile, ownerSeal: SealKeyPair): { mgr: EpochKeyManager; members: Members } {
  let state: AdminState;
  try {
    state = JSON.parse(dec.decode(openEnvelope({ chainId: f.chainId, purpose: PURPOSE_ADMIN, envelope: f.admin, keys: ownerSeal })));
  } catch {
    throw new CofferError("NOT_OWNER", "only the owner of this file can change who reads it");
  }
  const members: Members = Object.fromEntries(Object.entries(state.members).map(([a, k]) => [a, { mlkemPublicKey: fromBase64Url(k.k), x25519PublicKey: fromBase64Url(k.x) }]));
  const mgr = new EpochKeyManager({
    chainId: f.chainId, purpose: PURPOSE_EPOCH, mode: "hybrid", members,
    history: state.history.map((h) => ({ epoch: BigInt(h.epoch), key: fromBase64Url(h.key) })),
  });
  return { mgr, members };
}

async function build(
  base: { id: string; chainId: string; name: string; owner: string },
  mgr: EpochKeyManager, members: Members, envelope: Uint8Array,
  owner: Signer, version: bigint, plaintext: Uint8Array,
): Promise<CofferFile> {
  const ownerKeys = members[base.owner];
  if (!ownerKeys) throw new CofferError("OWNER_NOT_MEMBER", "the owner must stay a reader");
  const head = {
    v: FORMAT_VERSION, ...base, epoch: mgr.epoch, readers: mgr.members().sort(),
    key: envelope, admin: sealAdmin(base.chainId, ownerKeys, mgr, members),
  };
  const data = sealBatch({ epochKey: mgr.currentKey, context: context(base), batchIndex: version, data: plaintext }).blob;
  const access = accessHash(head);
  const dh = dataHash(data);
  const sig = await owner.sign(base.chainId, enc.encode(changeText({ id: base.id, epoch: head.epoch, version, access, data: dh, name: base.name, readers: head.readers })));
  return { ...head, change: { version, data: dh, sig }, version, writer: base.owner, data };
}

/** A new sealed file. The owner is the first reader; more readers can be passed at once. */
export async function createCoffer(args: {
  chainId: string; name: string; owner: Signer; ownerKeys: Omit<Reader, "address">; readers?: Reader[]; plaintext: Uint8Array;
}): Promise<CofferFile> {
  checkName(args.name);
  const members: Members = { [args.owner.address]: { mlkemPublicKey: args.ownerKeys.mlkemPublicKey, x25519PublicKey: args.ownerKeys.x25519PublicKey } };
  for (const r of args.readers ?? []) members[r.address] = { mlkemPublicKey: r.mlkemPublicKey, x25519PublicKey: r.x25519PublicKey };
  const mgr = new EpochKeyManager({ chainId: args.chainId, purpose: PURPOSE_EPOCH, mode: "hybrid", members });
  return build({ id: newFileId(), chainId: args.chainId, name: args.name, owner: args.owner.address }, mgr, members, mgr.distribution(), args.owner, 1n, args.plaintext);
}

/** The epoch key this reader holds for the file's current epoch. */
function epochKeyFor(f: CofferFile, keys: SealKeyPair) {
  try {
    return openEpochKey({ chainId: f.chainId, purpose: PURPOSE_EPOCH, envelope: f.key, keys });
  } catch (e) {
    if (isQoreSealError(e, "NOT_A_RECIPIENT")) throw new CofferError("NOT_A_READER", "this identity is not a reader of this file");
    throw e;
  }
}

/** Decrypt the env file. Does not check signatures: call verifyCoffer first. */
export function openCoffer(f: CofferFile, keys: SealKeyPair): Uint8Array {
  const ek = epochKeyFor(f, keys);
  if (ek.epoch !== f.epoch) throw new CofferError("EPOCH_MISMATCH", `key envelope is for epoch ${ek.epoch}, file says ${f.epoch}`);
  const b = openBatch({ blob: f.data, keys: [ek] });
  if (b.context !== context(f)) throw new CofferError("CONTEXT_MISMATCH", "sealed data belongs to a different file");
  return b.data;
}

/** Any reader can write new contents under the current epoch; readers are unchanged. */
export async function updateCoffer(f: CofferFile, writer: Signer, writerSeal: SealKeyPair, plaintext: Uint8Array): Promise<CofferFile> {
  if (!f.readers.includes(writer.address)) throw new CofferError("NOT_A_READER", "only a reader can write this file");
  const ek = epochKeyFor(f, writerSeal);
  const version = f.version + 1n;
  const data = sealBatch({ epochKey: ek, context: context(f), batchIndex: version, data: plaintext }).blob;
  const note = writerNote(f.name);
  const text = writeText({ id: f.id, epoch: f.epoch, version, access: accessHash(f), data: dataHash(data), note });
  const sig = await writer.sign(f.chainId, enc.encode(text));
  return { ...f, version, writer: writer.address, data, write: { note, sig } };
}

/** Add readers, or replace a reader's keys after they signed a new card. New epoch; reseals the contents. Owner only. */
export async function shareCoffer(f: CofferFile, owner: Signer, ownerSeal: SealKeyPair, readers: Reader[]): Promise<CofferFile> {
  if (owner.address !== f.owner) throw new CofferError("NOT_OWNER", "only the owner of this file can change who reads it");
  if (!readers.length) throw new CofferError("NOTHING_TO_DO", "no readers given");
  const plaintext = openCoffer(f, ownerSeal);
  const { mgr, members } = openAdmin(f, ownerSeal);
  let envelope: Uint8Array | null = null;
  for (const r of readers) {
    const keys = { mlkemPublicKey: r.mlkemPublicKey, x25519PublicKey: r.x25519PublicKey };
    members[r.address] = keys;
    envelope = mgr.addMember(r.address, keys).envelope;
  }
  if (!envelope) throw new CofferError("NOTHING_TO_DO", "no readers given");
  return build(f, mgr, members, envelope, owner, f.version + 1n, plaintext);
}

/**
 * Remove readers. Starts a new epoch they cannot open and reseals the contents.
 * Revoking cannot take back what they already read: `rotate` lists every key
 * in the file, which those readers could see.
 */
export async function revokeCoffer(f: CofferFile, owner: Signer, ownerSeal: SealKeyPair, addresses: string[], keyNames: (plaintext: Uint8Array) => string[]): Promise<{ file: CofferFile; rotate: string[] }> {
  if (owner.address !== f.owner) throw new CofferError("NOT_OWNER", "only the owner of this file can change who reads it");
  if (addresses.includes(f.owner)) throw new CofferError("OWNER_NOT_MEMBER", "the owner cannot be removed");
  if (!addresses.length) throw new CofferError("NOTHING_TO_DO", "no readers given");
  const plaintext = openCoffer(f, ownerSeal);
  const { mgr, members } = openAdmin(f, ownerSeal);
  let envelope: Uint8Array | null = null;
  for (const a of addresses) {
    if (!members[a]) throw new CofferError("NOT_A_READER", `${a} is not a reader`);
    delete members[a];
    envelope = mgr.removeMember(a).envelope;
  }
  if (!envelope) throw new CofferError("NOTHING_TO_DO", "no readers given");
  return { file: await build(f, mgr, members, envelope, owner, f.version + 1n, plaintext), rotate: keyNames(plaintext) };
}

// ---- checking ------------------------------------------------------------------

/**
 * Check the signatures against ML-DSA-87 keys the caller read from chain
 * (`pqKeys[address]`). Throws CofferError("BAD_SIGNATURE" | "WRITER_NOT_READER" | "UNKNOWN_KEY" | "BAD_FORMAT").
 */
export function verifyCoffer(f: CofferFile, pqKeys: Record<string, Uint8Array>): void {
  const check = (who: string, text: string, sig: MessageSignature, what: string) => {
    const pq = pqKeys[who];
    if (!pq) throw new CofferError("UNKNOWN_KEY", `no ML-DSA-87 key on chain for ${who}`);
    try {
      verifyMessage({ chainId: f.chainId, signer: who, data: enc.encode(text), signature: sig, pqPublicKey: pq, requirePq: true });
    } catch {
      throw new CofferError("BAD_SIGNATURE", `the ${what} signature by ${who} does not verify: this file was changed by someone else`);
    }
  };
  if (!f.readers.includes(f.owner)) throw new CofferError("OWNER_NOT_MEMBER", "the owner is not a reader of this file");
  const access = accessHash(f);
  check(f.owner, changeText({ id: f.id, epoch: f.epoch, version: f.change.version, access, data: f.change.data, name: f.name, readers: f.readers }), f.change.sig, "owner's");
  if (!f.write) {
    if (f.version !== f.change.version || dataHash(f.data) !== f.change.data || f.writer !== f.owner) {
      throw new CofferError("BAD_SIGNATURE", "the contents are not the ones the owner signed: this file was changed by someone else");
    }
    return;
  }
  if (!f.readers.includes(f.writer)) throw new CofferError("WRITER_NOT_READER", `${f.writer} wrote this file but is not a reader`);
  if (f.version <= f.change.version) throw new CofferError("BAD_FORMAT", "a write must come after the owner's change");
  check(f.writer, writeText({ id: f.id, epoch: f.epoch, version: f.version, access, data: dataHash(f.data), note: f.write.note }), f.write.sig, "writer's");
}

/** The file's head as the Coffer contract records it. */
export interface ChainHead { owner: string; epoch: bigint; version: bigint; access: string; data: string; height: number }

/**
 * Compare a file with its head on chain. Throws CofferError:
 * UNRECORDED (no head yet, or a newer epoch than the chain knows),
 * OWNER_MISMATCH (the id belongs to someone else), STALE (an older copy:
 * someone removed since may still be in it), FORKED (same epoch, other access).
 */
export function checkHead(f: CofferFile, head: ChainHead | null): void {
  if (!head) throw new CofferError("UNRECORDED", "this file is not recorded on QoreChain, so Coffer cannot tell if it is the latest copy");
  if (head.owner !== f.owner) throw new CofferError("OWNER_MISMATCH", `on QoreChain this file belongs to ${head.owner}, not ${f.owner}`);
  if (f.epoch < head.epoch) throw new CofferError("STALE", `this is an old copy: QoreChain has a newer one (epoch ${head.epoch}, this is ${f.epoch}). Someone removed since then may still be in it.`);
  if (f.epoch > head.epoch) throw new CofferError("UNRECORDED", `this copy (epoch ${f.epoch}) is newer than the one QoreChain knows (epoch ${head.epoch})`);
  if (head.access !== accessHash(f)) throw new CofferError("FORKED", "QoreChain has a different reader list for this version of the file");
}

/** What to send to the contract's setHead for the file's current change (the sealed file goes with it). */
export function headArgs(f: CofferFile) {
  return {
    file: f.id, owner: f.owner, epoch: f.epoch, version: f.change.version,
    access: accessHash(f), data: f.change.data, name: f.name, readers: sortByAddress(f.readers),
    pqSig: f.change.sig.pq?.signature ?? "",
  };
}

// ---- text format -----------------------------------------------------------

const HEADER = [
  "# Sealed by Coffer. Safe to commit: only the readers below can open it.",
  "# ML-KEM-1024 + X25519 to QoreChain addresses, signed with ML-DSA-87, recorded on QoreChain.",
  "# Run with it: npx github:jenzylove/coffer run -- <command>",
];

const jsonText = (o: unknown) => toBase64Url(enc.encode(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
const jsonParse = (t: string): any => JSON.parse(dec.decode(fromBase64Url(t)));

export function formatCoffer(f: CofferFile): string {
  const lines = [
    ...HEADER, "",
    `coffer: ${f.v}`, `id: ${f.id}`, `chain: ${f.chainId}`, `name: ${f.name}`, `owner: ${f.owner}`,
    `epoch: ${f.epoch}`, `readers: ${f.readers.join(" ")}`,
    `key: ${toBase64Url(f.key)}`, `admin: ${toBase64Url(f.admin)}`, `change: ${jsonText(f.change)}`,
    `version: ${f.version}`, `writer: ${f.writer}`,
    `data: ${toBase64Url(f.data)}`, `write: ${f.write ? jsonText(f.write) : "-"}`,
  ];
  return lines.join("\n") + "\n";
}

export function parseCoffer(text: string): CofferFile {
  const kv: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) throw new CofferError("BAD_FORMAT", `not a Coffer line: ${line.slice(0, 40)}`);
    kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const need = (k: string) => {
    const v = kv[k];
    if (v === undefined) throw new CofferError("BAD_FORMAT", `missing "${k}"`);
    return v;
  };
  const v = Number(need("coffer"));
  if (v === 1) throw new CofferError("OLD_FORMAT", "this file uses Coffer's first format, from before files were recorded on chain. Ask the owner to seal it again.");
  if (v !== FORMAT_VERSION) throw new CofferError("BAD_FORMAT", `unsupported Coffer format ${v}`);
  if (!/^[0-9a-f]{32}$/.test(need("id"))) throw new CofferError("BAD_FORMAT", "bad file id");
  try {
    const c = jsonParse(need("change"));
    const w = need("write");
    const wr = w === "-" ? undefined : jsonParse(w);
    const change: Change = { version: BigInt(c.version), data: String(c.data), sig: c.sig };
    if (!/^[0-9a-f]{64}$/.test(change.data)) throw new Error("bad data hash");
    return {
      v, id: need("id"), chainId: need("chain"), name: need("name"), owner: need("owner"), epoch: BigInt(need("epoch")),
      readers: need("readers").split(/\s+/).filter(Boolean),
      key: fromBase64Url(need("key")), admin: fromBase64Url(need("admin")), change,
      version: BigInt(need("version")), writer: need("writer"),
      data: fromBase64Url(need("data")),
      ...(wr ? { write: { note: String(wr.note), sig: wr.sig } } : {}),
    };
  } catch (e) {
    if (e instanceof CofferError) throw e;
    throw new CofferError("BAD_FORMAT", `damaged Coffer file: ${(e as Error).message}`);
  }
}
