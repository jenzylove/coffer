// The .env.coffer file (format 4).
//
// Each version's contents are sealed under a data key made of two pieces:
//   1. the epoch key, sealed to every current reader (ML-KEM-1024 + X25519 to
//      the keys in each reader's signed recipient card), and
//   2. a release piece made for this version only, sealed to the file's keeper
//      (and a copy to the owner, so the owner opens without asking).
// A reader gets the release piece by asking: the request names the file's
// latest version and a reply key made for this one open, and the Coffer
// contract on QoreChain refuses it unless the reader is on the file's current
// list. The keeper seals the piece to the reply key, the contract records the
// open, and the reader throws the reply key away. So the public record holds
// nothing a reader's long term key opens later: remove someone, or lose a
// laptop, and the files and the key on it open nothing more. The keeper holds
// only release pieces and can never read a file.
//
// The owner signs one "change" per change of who can read; a current reader
// signs one "write" per new version. The contract checks the same signatures
// before it records the file's head.
//
// Pure: no network, no disk. Keys from chain are passed in by the caller.
import {
  EpochKeyManager, openEpochKey, sealBatch, openBatch, seal, open as openEnvelope, generateSealKeys,
  toBase64Url, fromBase64Url, isQoreSealError,
} from "@qorechain/qoreseal";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { messagePqSignBytes, parseAddress, pqKeyFromSeed, pqSign, signMessage, verifyMessage } from "@qorechain/qoresign";
import type { MessageSignature, PqKeyPair } from "@qorechain/qoresign";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const FORMAT_VERSION = 4;
const PURPOSE_EPOCH = "coffer:epoch-key";
const PURPOSE_ADMIN = "coffer:admin";
const PURPOSE_RELEASE = "coffer:release"; // a version's release piece, sealed to the keeper
const PURPOSE_RELEASE_OWNER = "coffer:release-owner"; // the same piece, sealed to the owner
const PURPOSE_RELEASE_TO = "coffer:release-to"; // the same piece, sealed to a one time reply key for one open
/** Where people should be signing; named in every text a wallet shows. */
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

/** Someone to seal to: an address and the keys from its verified recipient card. */
export interface Reader {
  address: string;
  mlkemPublicKey: Uint8Array;
  x25519PublicKey: Uint8Array;
}

/** The owner's signed change: who can read, at which epoch, and the contents then. */
export interface Change {
  version: bigint;
  /** Hex SHA3-256 of the sealed data at that version. */
  data: string;
  sig: MessageSignature;
}

/** A reader's signed write of new contents under the current access block. */
export interface Write {
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
  /** The keeper: the only account that can unwrap the release piece. */
  keeper: string;
  /** Epoch key envelope, sealed to every reader. */
  key: Uint8Array;
  /** This version's release piece, sealed to the keeper (bound to this file, epoch and version). */
  release: Uint8Array;
  /** The same release piece sealed to the owner, so the owner opens without a request. */
  ownerCopy: Uint8Array;
  /** Owner-only envelope: member keys and epoch keys, so the owner can share and revoke from any machine. */
  admin: Uint8Array;
  change: Change;
  version: bigint;
  writer: string;
  /** The env file, sealed under the data key (epoch key + this version's release piece). */
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

/** The key the contents are sealed under: both pieces are needed. */
function dataKey(ek: { epoch: bigint; key: Uint8Array }, release: Uint8Array) {
  if (release.length !== 32) throw new CofferError("BAD_RELEASE", "the release piece is not 32 bytes");
  const ikm = new Uint8Array(ek.key.length + release.length);
  ikm.set(ek.key, 0);
  ikm.set(release, ek.key.length);
  return { epoch: ek.epoch, key: hkdf(sha256, ikm, undefined, enc.encode("coffer:data-key:v1"), 32) };
}

// ---- the texts that get signed (the contract rebuilds them byte for byte) ------

/** The access block: everything that decides who can read. Readers are sorted so order does not matter. */
export function accessBytes(f: Pick<CofferFile, "v" | "id" | "chainId" | "name" | "owner" | "epoch" | "readers" | "keeper" | "key" | "admin">): Uint8Array {
  return enc.encode([
    "coffer-access", String(f.v), f.id, f.chainId, f.name, f.owner, f.epoch.toString(),
    [...f.readers].sort().join(","), f.keeper, sha3hex(f.key), sha3hex(f.admin),
  ].join("\n"));
}

export const accessHash = (f: Parameters<typeof accessBytes>[0]) => sha3hex(accessBytes(f));

/** One version's contents: its release piece (keeper's and owner's copies) and the sealed data. */
export function contentHash(f: Pick<CofferFile, "release" | "ownerCopy" | "data">): string {
  return sha3hex(enc.encode(["coffer-content", sha3hex(f.release), sha3hex(f.ownerCopy), sha3hex(f.data)].join("\n")));
}

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

/** Byte for byte Coffer.sol's changeText: what the owner reads in the wallet and signs. */
export function changeText(a: { id: string; epoch: bigint; version: bigint; access: string; data: string; name: string; readers: string[] }): string {
  return `Coffer change v1\nFile: ${a.id}\nEpoch: ${a.epoch}\nVersion: ${a.version}\nAccess: ${a.access}\nData: ${a.data}` +
    `\nName: ${a.name}\nCan open it: ${sortByAddress(a.readers).join(", ")}\nSign this only on ${SITE}.`;
}

/** Byte for byte Coffer.sol's writeText: what a reader signs to write new contents. */
export function writeText(a: { id: string; epoch: bigint; version: bigint; access: string; data: string; name: string; writer: string }): string {
  return `Coffer write v2\nFile: ${a.id}\nEpoch: ${a.epoch}\nVersion: ${a.version}\nAccess: ${a.access}\nData: ${a.data}` +
    `\nName: ${a.name}\nWriter: ${a.writer}\nSign this only on ${SITE}.`;
}

/** One request to open a file, as the contract's OpenRequest. `replyKey` is the hex id of a reply key made for this open. */
export interface OpenRequest { file: string; epoch: bigint; version: bigint; reader: string; replyKey: string; nonce: bigint }

/** Byte for byte Coffer.sol's openText. */
export function openText(r: OpenRequest): string {
  return `Coffer open v2\nFile: ${r.file}\nEpoch: ${r.epoch}\nVersion: ${r.version}\nReader: ${r.reader}\nReply key: ${r.replyKey}\nNonce: ${r.nonce}\nSign this only on ${SITE}.`;
}

/** The id the contract records for a reply key: keccak256 of its ML-KEM-1024 and X25519 public keys, as hex. */
export function replyKeyId(k: { mlkemPublicKey: Uint8Array; x25519PublicKey: Uint8Array }): string {
  const b = new Uint8Array(k.mlkemPublicKey.length + k.x25519PublicKey.length);
  b.set(k.mlkemPublicKey, 0);
  b.set(k.x25519PublicKey, k.mlkemPublicKey.length);
  return hex(keccak_256(b));
}

/** A reply key for one open: made in memory, used once, never stored. */
export function newReplyKeys(): { keys: SealKeyPair; id: string } {
  const keys = generateSealKeys();
  return { keys, id: replyKeyId(keys) };
}

/** The id the contract gives a device key: keccak256 of its ML-DSA-87 public key, as hex. */
export const deviceId = (publicKey: Uint8Array) => hex(keccak_256(publicKey));

/** Byte for byte Coffer.sol's deviceText: what the wallet signs to approve a device for a while. */
export function deviceText(a: { account: string; id: string; untilBlock: bigint }): string {
  return `Coffer device v1\nAccount: ${a.account}\nDevice key: ${a.id}\nValid until block: ${a.untilBlock}\nSign this only on ${SITE}.`;
}

/** A new device key: an ML-DSA-87 key pair that stays on this machine and signs open requests. */
export function newDeviceKey(): PqKeyPair {
  return pqKeyFromSeed(crypto.getRandomValues(new Uint8Array(32)));
}

/** A random open request nonce (fits in uint64). */
export function newNonce(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return b.reduce((n, x) => (n << 8n) | BigInt(x), 0n) & 0x7fffffffffffffffn;
}

/** Sign an open request: with an approved device key (raw ML-DSA-87 over the message bytes), or the account's own signer. */
export async function signOpen(chainId: string, r: OpenRequest, by: { device: PqKeyPair } | { account: Signer }): Promise<Uint8Array> {
  const text = openText(r);
  if ("device" in by) return pqSign(by.device.secretKey, messagePqSignBytes(chainId, text));
  if (by.account.address !== r.reader) throw new CofferError("NOT_A_READER", "an open request must be signed by the reader");
  const sig = await by.account.sign(chainId, enc.encode(text));
  if (!sig.pq) throw new CofferError("BAD_SIGNATURE", "the signer gave no ML-DSA-87 signature");
  return fromBase64(sig.pq.signature);
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// ---- the release piece --------------------------------------------------------

const releaseAad = (file: string, epoch: bigint, version: bigint) => enc.encode(`${file}:${epoch}:${version}`);
const releaseToAad = (r: OpenRequest) => enc.encode(`${r.file}:${r.epoch}:${r.version}:${r.reader}:${r.replyKey}:${r.nonce}`);

/** Keeper: unwrap a version's release piece. Fails unless the envelope was made for exactly this file, epoch and version. */
export function keeperOpenRelease(a: { chainId: string; file: string; epoch: bigint; version: bigint; envelope: Uint8Array; keeperKeys: SealKeyPair }): Uint8Array {
  try {
    return openEnvelope({ chainId: a.chainId, purpose: PURPOSE_RELEASE, envelope: a.envelope, keys: a.keeperKeys, aad: releaseAad(a.file, a.epoch, a.version) });
  } catch {
    throw new CofferError("BAD_RELEASE", "that release piece was not sealed to this keeper for this file and version");
  }
}

/** Keeper: seal the release piece to the reply key named in a signed open request. Refuses any other key. */
export function sealReleaseTo(a: { chainId: string; request: OpenRequest; reply: { mlkemPublicKey: Uint8Array; x25519PublicKey: Uint8Array }; release: Uint8Array }): Uint8Array {
  if (replyKeyId(a.reply) !== a.request.replyKey) throw new CofferError("BAD_REPLY_KEY", "the reply key is not the one the request names");
  return seal({
    chainId: a.chainId, purpose: PURPOSE_RELEASE_TO, mode: "hybrid",
    recipients: [{ mlkemPublicKey: a.reply.mlkemPublicKey, x25519PublicKey: a.reply.x25519PublicKey }],
    plaintext: a.release, aad: releaseToAad(a.request),
  });
}

/** Reader: open the release piece the keeper sealed to this open's reply key. */
export function openReleaseTo(a: { chainId: string; request: OpenRequest; sealed: Uint8Array; replyKeys: SealKeyPair }): Uint8Array {
  try {
    return openEnvelope({ chainId: a.chainId, purpose: PURPOSE_RELEASE_TO, envelope: a.sealed, keys: a.replyKeys, aad: releaseToAad(a.request) });
  } catch {
    throw new CofferError("BAD_RELEASE", "the release piece does not open with this key");
  }
}

// ---- building ----------------------------------------------------------------

type Keys = { mlkemPublicKey: Uint8Array; x25519PublicKey: Uint8Array };
type Members = Record<string, Keys>;

function sealAdmin(chainId: string, owner: Keys, mgr: EpochKeyManager, members: Members): Uint8Array {
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

/** Owner: this version's release piece, from the owner's own copy (no request needed, so not logged). */
export function ownerRelease(f: CofferFile, ownerSeal: SealKeyPair): Uint8Array {
  try {
    return openEnvelope({ chainId: f.chainId, purpose: PURPOSE_RELEASE_OWNER, envelope: f.ownerCopy, keys: ownerSeal, aad: releaseAad(f.id, f.epoch, f.version) });
  } catch {
    throw new CofferError("BAD_RELEASE", "the owner's copy of the release piece does not open with this key");
  }
}

/** One version's contents: a fresh release piece for the keeper and the owner, and the data sealed under both pieces. */
function sealVersion(a: {
  chainId: string; id: string; owner: string; epochKey: { epoch: bigint; key: Uint8Array }; version: bigint;
  keeper: Keys; ownerKeys: Keys; plaintext: Uint8Array;
}): Pick<CofferFile, "release" | "ownerCopy" | "data"> {
  const r = crypto.getRandomValues(new Uint8Array(32));
  const aad = releaseAad(a.id, a.epochKey.epoch, a.version);
  const to = (purpose: string, k: Keys) => seal({
    chainId: a.chainId, purpose, mode: "hybrid", recipients: [{ mlkemPublicKey: k.mlkemPublicKey, x25519PublicKey: k.x25519PublicKey }], plaintext: r, aad,
  });
  const data = sealBatch({ epochKey: dataKey(a.epochKey, r), context: context({ chainId: a.chainId, owner: a.owner, id: a.id }), batchIndex: a.version, data: a.plaintext }).blob;
  return { release: to(PURPOSE_RELEASE, a.keeper), ownerCopy: to(PURPOSE_RELEASE_OWNER, a.ownerKeys), data };
}

async function build(
  base: { id: string; chainId: string; name: string; owner: string },
  mgr: EpochKeyManager, members: Members, envelope: Uint8Array,
  owner: Signer, keeper: Reader, version: bigint, plaintext: Uint8Array,
): Promise<CofferFile> {
  const ownerKeys = members[base.owner];
  if (!ownerKeys) throw new CofferError("OWNER_NOT_MEMBER", "the owner must stay a reader");
  const epoch = mgr.epoch;
  // Only these fields carry over: a reader's earlier write belongs to the version it wrote, not to this change.
  const head = {
    v: FORMAT_VERSION, id: base.id, chainId: base.chainId, name: base.name, owner: base.owner,
    epoch, readers: mgr.members().sort(), keeper: keeper.address,
    key: envelope, admin: sealAdmin(base.chainId, ownerKeys, mgr, members),
  };
  const content = sealVersion({ chainId: base.chainId, id: base.id, owner: base.owner, epochKey: mgr.currentKey, version, keeper, ownerKeys, plaintext });
  const access = accessHash(head);
  const dh = contentHash(content);
  // The contract takes a sealed file of at most 64 KB. Check before the owner signs anything,
  // with a stand-in signature of the real size, so nobody approves a change that cannot be recorded.
  const size = enc.encode(formatCoffer({ ...head, ...content, change: { version, data: dh, sig: SIZE_PROBE_SIG }, version, writer: base.owner })).length;
  if (size > MAX_SEALED_FILE) {
    throw new CofferError("TOO_MANY_READERS", `a sealed file holds about ${MAX_READERS_HINT} people; this one would be ${Math.ceil(size / 1024)} KB with ${head.readers.length}. Split the readers across two files.`);
  }
  const sig = await owner.sign(base.chainId, enc.encode(changeText({ id: base.id, epoch, version, access, data: dh, name: base.name, readers: head.readers })));
  return { ...head, ...content, change: { version, data: dh, sig }, version, writer: base.owner };
}

/** Coffer.sol's MAX_FILE, less a margin for a slightly longer signature encoding. */
export const MAX_SEALED_FILE = 65_536 - 256;
const MAX_READERS_HINT = 9;
const SIZE_PROBE_SIG: MessageSignature = {
  signatureType: "ml-dsa-87-hybrid",
  classical: { keyType: "eth_secp256k1", publicKey: "A".repeat(44), signature: "A".repeat(88) },
  pq: { algorithmId: 1, signature: "A".repeat(6172) }, // 4,627 byte ML-DSA-87 signature, base64
};

/** A new sealed file. The owner is the first reader; more readers can be passed at once. */
export async function createCoffer(args: {
  chainId: string; name: string; owner: Signer; ownerKeys: Omit<Reader, "address">; keeper: Reader; readers?: Reader[]; plaintext: Uint8Array;
}): Promise<CofferFile> {
  checkName(args.name);
  const members: Members = { [args.owner.address]: { mlkemPublicKey: args.ownerKeys.mlkemPublicKey, x25519PublicKey: args.ownerKeys.x25519PublicKey } };
  for (const r of args.readers ?? []) members[r.address] = { mlkemPublicKey: r.mlkemPublicKey, x25519PublicKey: r.x25519PublicKey };
  const mgr = new EpochKeyManager({ chainId: args.chainId, purpose: PURPOSE_EPOCH, mode: "hybrid", members });
  return build({ id: newFileId(), chainId: args.chainId, name: args.name, owner: args.owner.address }, mgr, members, mgr.distribution(), args.owner, args.keeper, 1n, args.plaintext);
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

/** Is this key one of the file's readers? (Checks the epoch key envelope; no release piece needed.) */
export function canRead(f: CofferFile, keys: SealKeyPair): boolean {
  try { epochKeyFor(f, keys); return true; } catch { return false; }
}

/** Decrypt the env file with the reader's key and the release piece. Does not check signatures: call verifyCoffer first. */
export function openCoffer(f: CofferFile, keys: SealKeyPair, release: Uint8Array): Uint8Array {
  const ek = epochKeyFor(f, keys);
  if (ek.epoch !== f.epoch) throw new CofferError("EPOCH_MISMATCH", `key envelope is for epoch ${ek.epoch}, file says ${f.epoch}`);
  let b;
  try {
    b = openBatch({ blob: f.data, keys: [dataKey(ek, release)] });
  } catch {
    throw new CofferError("BAD_RELEASE", "the release piece does not open this file");
  }
  if (b.context !== context(f)) throw new CofferError("CONTEXT_MISMATCH", "sealed data belongs to a different file");
  return b.data;
}

/**
 * Any current reader can write new contents under the current epoch; readers are unchanged.
 * The new version gets its own release piece, sealed to the keeper and to the owner (keys from
 * their cards on chain), so nobody's earlier release piece opens it.
 */
export async function updateCoffer(f: CofferFile, writer: Signer, writerSeal: SealKeyPair, keeper: Reader, owner: Reader, plaintext: Uint8Array): Promise<CofferFile> {
  if (!f.readers.includes(writer.address)) throw new CofferError("NOT_A_READER", "only a reader can write this file");
  if (owner.address !== f.owner) throw new CofferError("WRONG_OWNER", `this file's owner is ${f.owner}, not ${owner.address}`);
  const ek = epochKeyFor(f, writerSeal);
  if (ek.epoch !== f.epoch) throw new CofferError("EPOCH_MISMATCH", `key envelope is for epoch ${ek.epoch}, file says ${f.epoch}`);
  const version = f.version + 1n;
  const content = sealVersion({ chainId: f.chainId, id: f.id, owner: f.owner, epochKey: ek, version, keeper: sameKeeper(f, keeper), ownerKeys: owner, plaintext });
  const text = writeText({ id: f.id, epoch: f.epoch, version, access: accessHash(f), data: contentHash(content), name: f.name, writer: writer.address });
  const sig = await writer.sign(f.chainId, enc.encode(text));
  return { ...f, ...content, version, writer: writer.address, write: { sig } };
}

/** Add readers, or replace a reader's keys after they signed a new card. New epoch; reseals the contents. Owner only. */
export async function shareCoffer(f: CofferFile, owner: Signer, ownerSeal: SealKeyPair, keeper: Reader, readers: Reader[], release?: Uint8Array): Promise<CofferFile> {
  if (owner.address !== f.owner) throw new CofferError("NOT_OWNER", "only the owner of this file can change who reads it");
  if (!readers.length) throw new CofferError("NOTHING_TO_DO", "no readers given");
  const { mgr, members } = openAdmin(f, ownerSeal);
  const plaintext = openCoffer(f, ownerSeal, release ?? ownerRelease(f, ownerSeal));
  let envelope: Uint8Array | null = null;
  for (const r of readers) {
    const keys = { mlkemPublicKey: r.mlkemPublicKey, x25519PublicKey: r.x25519PublicKey };
    members[r.address] = keys;
    envelope = mgr.addMember(r.address, keys).envelope;
  }
  if (!envelope) throw new CofferError("NOTHING_TO_DO", "no readers given");
  return build(f, mgr, members, envelope, owner, sameKeeper(f, keeper), f.version + 1n, plaintext);
}

/**
 * Remove readers. Starts a new epoch they cannot open and reseals the contents.
 * From then on the contract refuses their opens, and no release piece on the
 * public record opens with their key, so no copy they hold opens for them.
 * What they already opened they may have kept: `rotate` lists every key in the file.
 */
export async function revokeCoffer(f: CofferFile, owner: Signer, ownerSeal: SealKeyPair, keeper: Reader, addresses: string[], keyNames: (plaintext: Uint8Array) => string[], release?: Uint8Array): Promise<{ file: CofferFile; rotate: string[] }> {
  if (owner.address !== f.owner) throw new CofferError("NOT_OWNER", "only the owner of this file can change who reads it");
  if (addresses.includes(f.owner)) throw new CofferError("OWNER_NOT_MEMBER", "the owner cannot be removed");
  if (!addresses.length) throw new CofferError("NOTHING_TO_DO", "no readers given");
  const { mgr, members } = openAdmin(f, ownerSeal);
  const plaintext = openCoffer(f, ownerSeal, release ?? ownerRelease(f, ownerSeal));
  let envelope: Uint8Array | null = null;
  for (const a of addresses) {
    if (!members[a]) throw new CofferError("NOT_A_READER", `${a} is not a reader`);
    delete members[a];
    envelope = mgr.removeMember(a).envelope;
  }
  if (!envelope) throw new CofferError("NOTHING_TO_DO", "no readers given");
  return { file: await build(f, mgr, members, envelope, owner, sameKeeper(f, keeper), f.version + 1n, plaintext), rotate: keyNames(plaintext) };
}

function sameKeeper(f: CofferFile, keeper: Reader) {
  if (keeper.address !== f.keeper) throw new CofferError("WRONG_KEEPER", `this file's keeper is ${f.keeper}, not ${keeper.address}`);
  return keeper;
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
  const data = contentHash(f);
  check(f.owner, changeText({ id: f.id, epoch: f.epoch, version: f.change.version, access, data: f.change.data, name: f.name, readers: f.readers }), f.change.sig, "owner's");
  if (!f.write) {
    if (f.version !== f.change.version || data !== f.change.data || f.writer !== f.owner) {
      throw new CofferError("BAD_SIGNATURE", "the contents are not the ones the owner signed: this file was changed by someone else");
    }
    return;
  }
  if (!f.readers.includes(f.writer)) throw new CofferError("WRITER_NOT_READER", `${f.writer} wrote this file but is not a reader`);
  if (f.version <= f.change.version) throw new CofferError("BAD_FORMAT", "a write must come after the owner's change");
  check(f.writer, writeText({ id: f.id, epoch: f.epoch, version: f.version, access, data, name: f.name, writer: f.writer }), f.write.sig, "writer's");
}

/** The file's head as the Coffer contract records it. */
export interface ChainHead { owner: string; epoch: bigint; version: bigint; access: string; data: string; height: number }

/**
 * Compare a file with its head on chain. Throws CofferError:
 * UNRECORDED (no head yet, or newer than the chain knows),
 * OWNER_MISMATCH (the id belongs to someone else), STALE (an older copy or
 * version: someone removed since may still be in it, or the values changed),
 * FORKED (same version, other readers or contents).
 */
export function checkHead(f: CofferFile, head: ChainHead | null): void {
  if (!head) throw new CofferError("UNRECORDED", "this file is not recorded on QoreChain, so Coffer cannot tell if it is the latest copy");
  if (head.owner !== f.owner) throw new CofferError("OWNER_MISMATCH", `on QoreChain this file belongs to ${head.owner}, not ${f.owner}`);
  if (f.epoch < head.epoch) throw new CofferError("STALE", `this is an old copy: QoreChain has a newer one (epoch ${head.epoch}, this is ${f.epoch}). Someone removed since then may still be in it.`);
  if (f.epoch > head.epoch) throw new CofferError("UNRECORDED", `this copy (epoch ${f.epoch}) is newer than the one QoreChain knows (epoch ${head.epoch})`);
  if (head.access !== accessHash(f)) throw new CofferError("FORKED", "QoreChain has a different reader list for this version of the file");
  if (f.version < head.version) throw new CofferError("STALE", `this is an older version: QoreChain has version ${head.version}, this is ${f.version}. Pull the latest one.`);
  if (f.version > head.version) throw new CofferError("UNRECORDED", `this version (${f.version}) is newer than the one QoreChain knows (${head.version})`);
  if (head.data !== contentHash(f)) throw new CofferError("FORKED", "QoreChain has different contents for this version of the file");
}

/** What to send to the contract's setHead for the file's current change (the sealed file goes with it). */
export function headArgs(f: CofferFile) {
  return {
    file: f.id, owner: f.owner, epoch: f.epoch, version: f.change.version,
    access: accessHash(f), data: f.change.data, name: f.name, readers: sortByAddress(f.readers),
    pqSig: f.change.sig.pq?.signature ?? "",
  };
}

/** What to send to the contract's write for a reader's write (the sealed file goes with it). */
export function writeArgs(f: CofferFile) {
  if (!f.write) throw new CofferError("NOTHING_TO_DO", "this version was not written by a reader");
  return {
    file: f.id, epoch: f.epoch, version: f.version, access: accessHash(f), data: contentHash(f), name: f.name, writer: f.writer,
    pqSig: f.write.sig.pq?.signature ?? "",
  };
}

// ---- text format -----------------------------------------------------------

const HEADER = [
  "# Sealed by Coffer. Safe to commit: only the readers below can open it, and only while they are on the list.",
  "# ML-KEM-1024 + X25519 to QoreChain addresses, signed with ML-DSA-87; every change, write and reader's open recorded on QoreChain.",
  "# Run with it: npx github:jenzylove/coffer run -- <command>",
];

const jsonText = (o: unknown) => toBase64Url(enc.encode(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
const jsonParse = (t: string): any => JSON.parse(dec.decode(fromBase64Url(t)));

export function formatCoffer(f: CofferFile): string {
  const lines = [
    ...HEADER, "",
    `coffer: ${f.v}`, `id: ${f.id}`, `chain: ${f.chainId}`, `name: ${f.name}`, `owner: ${f.owner}`,
    `epoch: ${f.epoch}`, `readers: ${f.readers.join(" ")}`, `keeper: ${f.keeper}`,
    `key: ${toBase64Url(f.key)}`, `release: ${toBase64Url(f.release)}`, `owner-copy: ${toBase64Url(f.ownerCopy)}`,
    `admin: ${toBase64Url(f.admin)}`, `change: ${jsonText(f.change)}`,
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
  if (v === 1 || v === 2 || v === 3) throw new CofferError("OLD_FORMAT", "this file uses an earlier Coffer format. Ask the owner to seal it again.");
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
      readers: need("readers").split(/\s+/).filter(Boolean), keeper: need("keeper"),
      key: fromBase64Url(need("key")), release: fromBase64Url(need("release")), ownerCopy: fromBase64Url(need("owner-copy")), admin: fromBase64Url(need("admin")), change,
      version: BigInt(need("version")), writer: need("writer"),
      data: fromBase64Url(need("data")),
      ...(wr ? { write: { sig: wr.sig } } : {}),
    };
  } catch (e) {
    if (e instanceof CofferError) throw e;
    throw new CofferError("BAD_FORMAT", `damaged Coffer file: ${(e as Error).message}`);
  }
}
