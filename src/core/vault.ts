// The .env.coffer file: an env file sealed under an epoch key, the epoch key
// sealed with ML-KEM-1024 to every current reader, and two ML-DSA-87 hybrid
// signatures (the owner signs who can read; the writer signs what was written).
// Pure: no network, no disk. Keys from chain are passed in by the caller.
import {
  EpochKeyManager, openEpochKey, sealBatch, openBatch, seal, open as openEnvelope,
  toBase64Url, fromBase64Url, isQoreSealError,
} from "@qorechain/qoreseal";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { signMessage, verifyMessage } from "@qorechain/qoresign";
import type { MessageSignature } from "@qorechain/qoresign";
import { sha3_256 } from "@noble/hashes/sha3.js";

export const FORMAT_VERSION = 1;
const PURPOSE_EPOCH = "coffer:epoch-key";
const PURPOSE_ADMIN = "coffer:admin";

/** An account that signs: its address and both keys. */
export interface Signer {
  address: string;
  classicalKey: Parameters<typeof signMessage>[0]["classicalKey"];
  pqKey: { secretKey: Uint8Array };
}

/** A reader to seal to: an address and the ML-KEM-1024 key registered for it on chain. */
export interface Reader {
  address: string;
  mlkemPublicKey: Uint8Array;
}

export interface CofferFile {
  v: number;
  chainId: string;
  name: string;
  owner: string;
  epoch: bigint;
  readers: string[];
  /** Epoch key envelope, sealed to every reader. */
  key: Uint8Array;
  /** Owner-only envelope: member keys and epoch history, so the owner can share and revoke from any machine. */
  admin: Uint8Array;
  /** Owner's signature over the access block. */
  access: MessageSignature;
  version: bigint;
  writer: string;
  /** The env file, sealed under the epoch key. */
  data: Uint8Array;
  /** Writer's signature over the data block. */
  write: MessageSignature;
}

interface AdminState {
  members: Record<string, string>; // address -> base64url ML-KEM public key
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
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function context(f: Pick<CofferFile, "chainId" | "owner" | "name">) {
  // QoreSeal purposes/contexts are restricted to a safe charset; hash the file name in.
  return `coffer:${f.chainId}:${f.owner}:${hex(sha3_256(enc.encode(f.name))).slice(0, 32)}`;
}

/** The exact bytes the owner signs. Readers are sorted so order does not matter. */
export function accessBytes(f: Pick<CofferFile, "v" | "chainId" | "name" | "owner" | "epoch" | "readers" | "key" | "admin">): Uint8Array {
  return enc.encode([
    "coffer-access", String(f.v), f.chainId, f.name, f.owner, f.epoch.toString(),
    [...f.readers].sort().join(","), hex(sha3_256(f.key)), hex(sha3_256(f.admin)),
  ].join("\n"));
}

/** The exact bytes the writer signs. Binds the data to the access block it was written under. */
export function writeBytes(f: Omit<CofferFile, "write">): Uint8Array {
  return enc.encode([
    "coffer-write", String(f.v), f.chainId, f.name, f.owner, f.epoch.toString(),
    f.version.toString(), f.writer, hex(sha3_256(f.data)), hex(sha3_256(accessBytes(f))),
  ].join("\n"));
}

function sign(chainId: string, s: Signer, data: Uint8Array): MessageSignature {
  return signMessage({ chainId, signer: s.address, data, classicalKey: s.classicalKey, pqKey: s.pqKey });
}

function sealAdmin(chainId: string, ownerKey: Uint8Array, mgr: EpochKeyManager, members: Record<string, Uint8Array>): Uint8Array {
  const state: AdminState = {
    members: Object.fromEntries(Object.entries(members).map(([a, k]) => [a, toBase64Url(k)])),
    history: mgr.exportKeys().map((k) => ({ epoch: k.epoch.toString(), key: toBase64Url(k.key) })),
  };
  return seal({ chainId, purpose: PURPOSE_ADMIN, recipients: [{ mlkemPublicKey: ownerKey }], plaintext: enc.encode(JSON.stringify(state)), mode: "mlkem" });
}

function openAdmin(f: CofferFile, ownerSeal: SealKeyPair): { mgr: EpochKeyManager; members: Record<string, Uint8Array> } {
  let state: AdminState;
  try {
    state = JSON.parse(dec.decode(openEnvelope({ chainId: f.chainId, purpose: PURPOSE_ADMIN, envelope: f.admin, keys: ownerSeal })));
  } catch {
    throw new CofferError("NOT_OWNER", "only the owner of this file can change who reads it");
  }
  const members = Object.fromEntries(Object.entries(state.members).map(([a, k]) => [a, fromBase64Url(k)]));
  const mgr = new EpochKeyManager({
    chainId: f.chainId, purpose: PURPOSE_EPOCH, mode: "mlkem",
    members: Object.fromEntries(Object.entries(members).map(([a, k]) => [a, { mlkemPublicKey: k }])),
    history: state.history.map((h) => ({ epoch: BigInt(h.epoch), key: fromBase64Url(h.key) })),
  });
  return { mgr, members };
}

function build(
  base: { chainId: string; name: string; owner: string },
  mgr: EpochKeyManager, members: Record<string, Uint8Array>, envelope: Uint8Array,
  owner: Signer, writer: Signer, version: bigint, plaintext: Uint8Array,
): CofferFile {
  const ownerKey = members[base.owner];
  if (!ownerKey) throw new CofferError("OWNER_NOT_MEMBER", "the owner must stay a reader");
  const head = {
    v: FORMAT_VERSION, ...base, epoch: mgr.epoch, readers: mgr.members().sort(),
    key: envelope, admin: sealAdmin(base.chainId, ownerKey, mgr, members),
  };
  const access = sign(base.chainId, owner, accessBytes(head));
  const data = sealBatch({ epochKey: mgr.currentKey, context: context(base), batchIndex: version, data: plaintext }).blob;
  const body = { ...head, access, version, writer: writer.address, data };
  return { ...body, write: sign(base.chainId, writer, writeBytes(body)) };
}

/** A new sealed file. The owner is the first reader; more readers can be passed at once. */
export function createCoffer(args: {
  chainId: string; name: string; owner: Signer; ownerMlkem: Uint8Array; readers?: Reader[]; plaintext: Uint8Array;
}): CofferFile {
  const members: Record<string, Uint8Array> = { [args.owner.address]: args.ownerMlkem };
  for (const r of args.readers ?? []) members[r.address] = r.mlkemPublicKey;
  const mgr = new EpochKeyManager({
    chainId: args.chainId, purpose: PURPOSE_EPOCH, mode: "mlkem",
    members: Object.fromEntries(Object.entries(members).map(([a, k]) => [a, { mlkemPublicKey: k }])),
  });
  const envelope = mgr.distribution();
  return build({ chainId: args.chainId, name: args.name, owner: args.owner.address }, mgr, members, envelope, args.owner, args.owner, 1n, args.plaintext);
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
export function updateCoffer(f: CofferFile, writer: Signer, writerSeal: SealKeyPair, plaintext: Uint8Array): CofferFile {
  if (!f.readers.includes(writer.address)) throw new CofferError("NOT_A_READER", "only a reader can write this file");
  const ek = epochKeyFor(f, writerSeal);
  const version = f.version + 1n;
  const data = sealBatch({ epochKey: ek, context: context(f), batchIndex: version, data: plaintext }).blob;
  const { write: _w, ...rest } = f;
  const body = { ...rest, version, writer: writer.address, data };
  return { ...body, write: sign(f.chainId, writer, writeBytes(body)) };
}

/** Add readers. Starts a new epoch and reseals the contents. Owner only. */
export function shareCoffer(f: CofferFile, owner: Signer, ownerSeal: SealKeyPair, readers: Reader[]): CofferFile {
  if (owner.address !== f.owner) throw new CofferError("NOT_OWNER", "only the owner of this file can change who reads it");
  const plaintext = openCoffer(f, ownerSeal);
  const { mgr, members } = openAdmin(f, ownerSeal);
  let rot;
  for (const r of readers) { members[r.address] = r.mlkemPublicKey; rot = mgr.addMember(r.address, { mlkemPublicKey: r.mlkemPublicKey }); }
  if (!rot?.envelope) throw new CofferError("NOTHING_TO_DO", "no readers given");
  return build(f, mgr, members, rot.envelope, owner, owner, f.version + 1n, plaintext);
}

/**
 * Remove readers. Starts a new epoch they cannot open and reseals the contents.
 * Revoking cannot take back what they already read: `rotate` lists every key
 * in the file, which those readers could see.
 */
export function revokeCoffer(f: CofferFile, owner: Signer, ownerSeal: SealKeyPair, addresses: string[], keyNames: (plaintext: Uint8Array) => string[]): { file: CofferFile; rotate: string[] } {
  if (owner.address !== f.owner) throw new CofferError("NOT_OWNER", "only the owner of this file can change who reads it");
  if (addresses.includes(f.owner)) throw new CofferError("OWNER_NOT_MEMBER", "the owner cannot be removed");
  const plaintext = openCoffer(f, ownerSeal);
  const { mgr, members } = openAdmin(f, ownerSeal);
  let rot;
  for (const a of addresses) {
    if (!members[a]) throw new CofferError("NOT_A_READER", `${a} is not a reader`);
    delete members[a];
    rot = mgr.removeMember(a);
  }
  if (!rot?.envelope) throw new CofferError("NOTHING_TO_DO", "no readers given");
  return { file: build(f, mgr, members, rot.envelope, owner, owner, f.version + 1n, plaintext), rotate: keyNames(plaintext) };
}

/**
 * Check both signatures against ML-DSA-87 keys the caller read from chain
 * (`pqKeys[address]`). Throws CofferError("BAD_SIGNATURE" | "WRITER_NOT_READER" | "UNKNOWN_KEY").
 */
export function verifyCoffer(f: CofferFile, pqKeys: Record<string, Uint8Array>): void {
  const check = (who: string, data: Uint8Array, sig: MessageSignature, what: string) => {
    const pq = pqKeys[who];
    if (!pq) throw new CofferError("UNKNOWN_KEY", `no ML-DSA-87 key on chain for ${who}`);
    try {
      verifyMessage({ chainId: f.chainId, signer: who, data, signature: sig, pqPublicKey: pq, requirePq: true });
    } catch {
      throw new CofferError("BAD_SIGNATURE", `the ${what} signature by ${who} does not verify: this file was changed by someone else`);
    }
  };
  check(f.owner, accessBytes(f), f.access, "access");
  if (!f.readers.includes(f.writer)) throw new CofferError("WRITER_NOT_READER", `${f.writer} wrote this file but is not a reader`);
  const { write: _w, ...body } = f;
  check(f.writer, writeBytes(body), f.write, "write");
}

// ---- text format -----------------------------------------------------------

const HEADER = [
  "# Sealed by Coffer. Safe to commit: only the readers below can open it.",
  "# ML-KEM-1024 + AES-256-GCM to QoreChain addresses, signed with ML-DSA-87.",
  "# Run with it: npx @jenzylove/coffer run -- <command>",
];

const sigText = (s: MessageSignature) => toBase64Url(enc.encode(JSON.stringify(s)));
const sigParse = (t: string): MessageSignature => JSON.parse(dec.decode(fromBase64Url(t)));

export function formatCoffer(f: CofferFile): string {
  const lines = [
    ...HEADER, "",
    `coffer: ${f.v}`, `chain: ${f.chainId}`, `name: ${f.name}`, `owner: ${f.owner}`,
    `epoch: ${f.epoch}`, `readers: ${f.readers.join(" ")}`,
    `key: ${toBase64Url(f.key)}`, `admin: ${toBase64Url(f.admin)}`, `access: ${sigText(f.access)}`,
    `version: ${f.version}`, `writer: ${f.writer}`,
    `data: ${toBase64Url(f.data)}`, `write: ${sigText(f.write)}`,
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
  if (v !== FORMAT_VERSION) throw new CofferError("BAD_FORMAT", `unsupported Coffer format ${v}`);
  try {
    return {
      v, chainId: need("chain"), name: need("name"), owner: need("owner"), epoch: BigInt(need("epoch")),
      readers: need("readers").split(/\s+/).filter(Boolean),
      key: fromBase64Url(need("key")), admin: fromBase64Url(need("admin")), access: sigParse(need("access")),
      version: BigInt(need("version")), writer: need("writer"),
      data: fromBase64Url(need("data")), write: sigParse(need("write")),
    };
  } catch (e) {
    if (e instanceof CofferError) throw e;
    throw new CofferError("BAD_FORMAT", `damaged Coffer file: ${(e as Error).message}`);
  }
}
