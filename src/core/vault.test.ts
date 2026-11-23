import { test } from "node:test";
import assert from "node:assert/strict";
import { identityFromMnemonic, newMnemonic, type Identity } from "./identity.ts";
import {
  createCoffer, openCoffer, shareCoffer, revokeCoffer, updateCoffer, verifyCoffer, checkHead, headArgs, writeArgs, accessHash, contentHash,
  changeText, writeText, openText, deviceText, deviceId, localSigner, formatCoffer, parseCoffer, CofferError, canRead, ownerRelease,
  keeperOpenRelease, sealReleaseTo, openReleaseTo, signOpen, newDeviceKey, newNonce, newReplyKeys, replyKeyId,
  type CofferFile, type Reader, type ChainHead, type OpenRequest,
} from "./vault.ts";
import { signCard, readerFromCard } from "./card.ts";
import { messagePqSignBytes, pqVerify, verifyMessage } from "@qorechain/qoresign";

const CHAIN = "qorechain-diana";
const enc = new TextEncoder();
const dec = new TextDecoder();
const ENV = "OPENAI_API_KEY=sk-test-123\nDATABASE_URL=postgres://u:p@db:5432/app\n";

const [A, B, C, X, K] = [0, 1, 2, 3, 4].map(() => identityFromMnemonic(newMnemonic())) as [Identity, Identity, Identity, Identity, Identity];
const reader = (i: Identity): Reader => ({ address: i.address, mlkemPublicKey: i.sealKeys.mlkemPublicKey, x25519PublicKey: i.sealKeys.x25519PublicKey });
const KEEPER = reader(K);
const S = (i: Identity) => localSigner(i);
const pq = Object.fromEntries([A, B, C, X, K].map((i) => [i.address, i.pqKey.publicKey]));
const names = (p: Uint8Array) => dec.decode(p).split("\n").filter(Boolean).map((l) => l.split("=")[0]!);
const isCode = (c: string) => (e: unknown) => e instanceof CofferError && e.code === c;

const create = (owner: Identity, readers: Identity[] = [], plaintext = ENV, name = ".env") =>
  createCoffer({ chainId: CHAIN, name, owner: S(owner), ownerKeys: owner.sealKeys, keeper: KEEPER, readers: readers.map(reader), plaintext: enc.encode(plaintext) });
const base = () => create(A, [B, C]);
const headOf = (f: CofferFile): ChainHead => ({ owner: f.owner, epoch: f.epoch, version: f.version, access: accessHash(f), data: contentHash(f), height: 1 });
const keeperPiece = (f: CofferFile) => keeperOpenRelease({ chainId: CHAIN, file: f.id, epoch: f.epoch, version: f.version, envelope: f.release, keeperKeys: K.sealKeys });
const write = (f: CofferFile, who: Identity, plaintext: string) => updateCoffer(f, S(who), who.sealKeys, KEEPER, reader(A), enc.encode(plaintext));

/**
 * The whole open path, as the keeper and the contract run it: a signed request naming the latest
 * version and a fresh reply key; the keeper unwraps this version's piece and seals it to that reply
 * key; `sealed` is exactly what the Opened event publishes. The reader opens it and drops the key.
 */
function openVia(f: CofferFile, who: Identity) {
  const reply = newReplyKeys();
  const request: OpenRequest = { file: f.id, epoch: f.epoch, version: f.version, reader: who.address, replyKey: reply.id, nonce: newNonce() };
  const sealed = sealReleaseTo({ chainId: CHAIN, request, reply: reply.keys, release: keeperPiece(f) });
  const piece = openReleaseTo({ chainId: CHAIN, request, sealed, replyKeys: reply.keys });
  return { text: dec.decode(openCoffer(f, who.sealKeys, piece)), request, sealed, piece };
}

test("readers open through the keeper; signatures verify", async () => {
  const f = await base();
  verifyCoffer(f, pq);
  for (const i of [A, B, C]) assert.equal(openVia(f, i).text, ENV);
  assert.equal(f.keeper, K.address);
  assert.throws(() => openVia(f, X), isCode("NOT_A_READER"));
  assert.ok(canRead(f, B.sealKeys) && !canRead(f, X.sealKeys));
  assert.match(f.id, /^[0-9a-f]{32}$/);
});

test("the public record of an open holds nothing the reader's own key, or anyone else's, can open", async () => {
  // The judge's attack on format 3: read the Opened event, unwrap the release with the reader's card key.
  const f = await base();
  const { request, sealed } = openVia(f, B);
  for (const keys of [B.sealKeys, A.sealKeys, C.sealKeys, K.sealKeys, newReplyKeys().keys]) {
    assert.throws(() => openReleaseTo({ chainId: CHAIN, request, sealed, replyKeys: keys }), isCode("BAD_RELEASE"));
  }
});

test("the keeper seals only to the reply key the signed request names", async () => {
  const f = await base();
  const reply = newReplyKeys();
  const request: OpenRequest = { file: f.id, epoch: f.epoch, version: f.version, reader: B.address, replyKey: reply.id, nonce: 7n };
  assert.throws(() => sealReleaseTo({ chainId: CHAIN, request, reply: B.sealKeys, release: keeperPiece(f) }), isCode("BAD_REPLY_KEY"));
  assert.throws(() => sealReleaseTo({ chainId: CHAIN, request, reply: newReplyKeys().keys, release: keeperPiece(f) }), isCode("BAD_REPLY_KEY"));
  assert.equal(replyKeyId(reply.keys), reply.id);
  assert.match(reply.id, /^[0-9a-f]{64}$/);
  // a sealed release opens only for the exact request it answered
  const sealed = sealReleaseTo({ chainId: CHAIN, request, reply: reply.keys, release: keeperPiece(f) });
  for (const other of [{ ...request, nonce: 8n }, { ...request, reader: C.address }, { ...request, version: request.version + 1n }]) {
    assert.throws(() => openReleaseTo({ chainId: CHAIN, request: other, sealed, replyKeys: reply.keys }), isCode("BAD_RELEASE"));
  }
});

test("a reader's own key is not enough: the release piece is needed", async () => {
  const f = await base();
  const wrong = crypto.getRandomValues(new Uint8Array(32));
  assert.throws(() => openCoffer(f, B.sealKeys, wrong), isCode("BAD_RELEASE"));
  // and the keeper alone cannot read: its key is not a reader's
  assert.throws(() => openCoffer(f, K.sealKeys, keeperPiece(f)), isCode("NOT_A_READER"));
});

test("each version has its own release piece: one kept from an earlier open opens nothing newer", async () => {
  const f = await base();
  const kept = openVia(f, B).piece;
  const g = await write(f, A, ENV + "NEW=1\n");
  assert.throws(() => openCoffer(g, B.sealKeys, kept), isCode("BAD_RELEASE"));
  assert.equal(openVia(g, B).text, ENV + "NEW=1\n");
  const { file: h } = await revokeCoffer(g, S(A), A.sealKeys, KEEPER, [C.address], names);
  assert.throws(() => openCoffer(h, B.sealKeys, kept), isCode("BAD_RELEASE"));
});

test("a release piece is bound to its file, epoch and version", async () => {
  const f = await base();
  const g = await base();
  const k = (envelope: Uint8Array, file: string, epoch: bigint, version: bigint, keys = K.sealKeys) =>
    keeperOpenRelease({ chainId: CHAIN, file, epoch, version, envelope, keeperKeys: keys });
  assert.throws(() => k(f.release, g.id, g.epoch, g.version), isCode("BAD_RELEASE"));
  assert.throws(() => k(f.release, f.id, f.epoch + 1n, f.version), isCode("BAD_RELEASE"));
  assert.throws(() => k(f.release, f.id, f.epoch, f.version + 1n), isCode("BAD_RELEASE"));
  assert.throws(() => k(f.release, f.id, f.epoch, f.version, X.sealKeys), isCode("BAD_RELEASE"));
});

test("the owner opens with its own copy of the release piece", async () => {
  const f = await base();
  assert.equal(dec.decode(openCoffer(f, A.sealKeys, ownerRelease(f, A.sealKeys))), ENV);
  assert.throws(() => ownerRelease(f, B.sealKeys), isCode("BAD_RELEASE"));
  const g = await write(f, B, "Z=1\n");
  assert.equal(dec.decode(openCoffer(g, A.sealKeys, ownerRelease(g, A.sealKeys))), "Z=1\n");
});

test("the owner signs one change, and it is the text the contract checks", async () => {
  const signed: string[] = [];
  const counting = { address: A.address, sign: async (chainId: string, data: Uint8Array) => { signed.push(dec.decode(data)); return S(A).sign(chainId, data); } };
  const f = await createCoffer({ chainId: CHAIN, name: ".env", owner: counting, ownerKeys: A.sealKeys, keeper: KEEPER, readers: [reader(B)], plaintext: enc.encode(ENV) });
  assert.equal(signed.length, 1);
  const h = headArgs(f);
  assert.equal(h.data, contentHash(f));
  assert.equal(signed[0], changeText({ id: h.file, epoch: h.epoch, version: h.version, access: h.access, data: h.data, name: h.name, readers: h.readers }));
  assert.match(signed[0]!, /^Coffer change v1\nFile: [0-9a-f]{32}\nEpoch: \d+\nVersion: 1\nAccess: [0-9a-f]{64}\nData: [0-9a-f]{64}\nName: \.env\nCan open it: qor1\w+, qor1\w+\nSign this only on coffer\.jdollar\.site\.$/);
});

test("open requests: the exact text, signed by the reader or by an approved device", async () => {
  const req: OpenRequest = { file: "00112233445566778899aabbccddeeff", epoch: 3n, version: 12n, reader: B.address, replyKey: "ab".repeat(32), nonce: 42n };
  assert.equal(openText(req), `Coffer open v2\nFile: 00112233445566778899aabbccddeeff\nEpoch: 3\nVersion: 12\nReader: ${B.address}\nReply key: ${"ab".repeat(32)}\nNonce: 42\nSign this only on coffer.jdollar.site.`);
  const byAccount = await signOpen(CHAIN, req, { account: S(B) });
  assert.ok(pqVerify(B.pqKey.publicKey, messagePqSignBytes(CHAIN, openText(req)), byAccount));
  await assert.rejects(signOpen(CHAIN, req, { account: S(C) }), isCode("NOT_A_READER"));
  const device = newDeviceKey();
  const byDevice = await signOpen(CHAIN, req, { device });
  assert.ok(pqVerify(device.publicKey, messagePqSignBytes(CHAIN, openText(req)), byDevice));
  assert.ok(!pqVerify(device.publicKey, messagePqSignBytes(CHAIN, openText({ ...req, nonce: 43n })), byDevice));
  assert.ok(!pqVerify(device.publicKey, messagePqSignBytes(CHAIN, openText({ ...req, replyKey: "cd".repeat(32) })), byDevice));
  const id = deviceId(device.publicKey);
  assert.match(id, /^[0-9a-f]{64}$/);
  const text = deviceText({ account: B.address, id, untilBlock: 123n });
  assert.equal(text, `Coffer device v1\nAccount: ${B.address}\nDevice key: ${id}\nValid until block: 123\nSign this only on coffer.jdollar.site.`);
  verifyMessage({ chainId: CHAIN, signer: B.address, data: enc.encode(text), signature: await S(B).sign(CHAIN, enc.encode(text)), pqPublicKey: B.pqKey.publicKey, requirePq: true });
});

test("share adds a reader in a new epoch, with a new release piece", async () => {
  const f0 = await create(A);
  const f1 = await shareCoffer(f0, S(A), A.sealKeys, KEEPER, [reader(B)]);
  verifyCoffer(f1, pq);
  assert.ok(f1.epoch > f0.epoch && f1.version > f0.version);
  assert.equal(openVia(f1, B).text, ENV);
  assert.throws(() => openVia({ ...f1, key: f0.key }, B), isCode("NOT_A_READER"));
  assert.notDeepEqual(keeperPiece(f1), keeperPiece(f0));
  await assert.rejects(shareCoffer(f1, S(A), A.sealKeys, reader(X), [reader(C)]), isCode("WRONG_KEEPER"));
});

test("share with a reader's new card replaces their keys", async () => {
  const f0 = await base();
  const B2 = identityFromMnemonic(newMnemonic());
  const moved: Reader = { address: B.address, mlkemPublicKey: B2.sealKeys.mlkemPublicKey, x25519PublicKey: B2.sealKeys.x25519PublicKey };
  const f1 = await shareCoffer(f0, S(A), A.sealKeys, KEEPER, [moved]);
  assert.ok(canRead(f1, B2.sealKeys) && !canRead(f1, B.sealKeys));
  assert.deepEqual(f1.readers, f0.readers);
});

test("revoke locks a reader out of the new epoch and lists keys to rotate", async () => {
  const f = await base();
  const { file, rotate } = await revokeCoffer(f, S(A), A.sealKeys, KEEPER, [C.address], names);
  verifyCoffer(file, pq);
  assert.deepEqual(rotate, ["OPENAI_API_KEY", "DATABASE_URL"]);
  assert.equal(openVia(file, B).text, ENV);
  assert.throws(() => openVia(file, C), isCode("NOT_A_READER"));
  assert.ok(!file.readers.includes(C.address));
  // C still holds its epoch key for the old copy; the contract refuses its opens (Coffer.t.sol) and nothing public opens with its key
  assert.ok(canRead(f, C.sealKeys));
});

test("share and revoke after a reader's write start a clean change", async () => {
  const f = await base();
  const g = await write(f, B, ENV + "NEW=1\n");
  const { file: h } = await revokeCoffer(g, S(A), A.sealKeys, KEEPER, [C.address], names);
  verifyCoffer(h, pq);
  assert.equal(h.write, undefined);
  assert.equal(h.writer, A.address);
  assert.ok(h.version > g.version);
  assert.equal(openVia(h, B).text, ENV + "NEW=1\n");
  const k = await shareCoffer(await write(h, B, "Z=2\n"), S(A), A.sealKeys, KEEPER, [reader(X)]);
  verifyCoffer(k, pq);
  assert.equal(openVia(k, X).text, "Z=2\n");
});

test("only the owner can share or revoke; the owner cannot be removed", async () => {
  const f = await base();
  await assert.rejects(shareCoffer(f, S(B), B.sealKeys, KEEPER, [reader(X)]), isCode("NOT_OWNER"));
  await assert.rejects(revokeCoffer(f, S(B), B.sealKeys, KEEPER, [C.address], names), isCode("NOT_OWNER"));
  await assert.rejects(revokeCoffer(f, S(A), A.sealKeys, KEEPER, [A.address], names), isCode("OWNER_NOT_MEMBER"));
  await assert.rejects(revokeCoffer(f, S(A), A.sealKeys, KEEPER, [X.address], names), isCode("NOT_A_READER"));
});

test("a reader writes a new version, signed with the exact text the contract checks; a non-reader cannot", async () => {
  const f = await base();
  const signed: string[] = [];
  const counting = { address: B.address, sign: async (c: string, d: Uint8Array) => { signed.push(dec.decode(d)); return S(B).sign(c, d); } };
  const g = await updateCoffer(f, counting, B.sealKeys, KEEPER, reader(A), enc.encode(ENV + "NEW=1\n"));
  verifyCoffer(g, pq);
  assert.equal(g.writer, B.address);
  assert.equal(g.version, f.version + 1n);
  assert.equal(openVia(g, C).text, ENV + "NEW=1\n");
  const w = writeArgs(g);
  assert.equal(signed[0], writeText({ id: w.file, epoch: w.epoch, version: w.version, access: w.access, data: w.data, name: w.name, writer: w.writer }));
  assert.match(signed[0]!, /^Coffer write v2\nFile: [0-9a-f]{32}\nEpoch: \d+\nVersion: 2\nAccess: [0-9a-f]{64}\nData: [0-9a-f]{64}\nName: \.env\nWriter: qor1\w+\nSign this only on coffer\.jdollar\.site\.$/);
  assert.equal(w.access, accessHash(f));
  await assert.rejects(updateCoffer(f, S(X), X.sealKeys, KEEPER, reader(A), enc.encode("x")), isCode("NOT_A_READER"));
  await assert.rejects(updateCoffer(f, S(B), B.sealKeys, reader(X), reader(A), enc.encode("x")), isCode("WRONG_KEEPER"));
  await assert.rejects(updateCoffer(f, S(B), B.sealKeys, KEEPER, reader(C), enc.encode("x")), isCode("WRONG_OWNER"));
  checkHead(g, headOf(g));
  assert.throws(() => checkHead(f, headOf(g)), isCode("STALE"));
  assert.throws(() => checkHead(g, headOf(f)), isCode("UNRECORDED"));
});

test("text format round-trips, with and without a write", async () => {
  const f = await base();
  for (const x of [f, await write(f, B, "Z=1\n")]) {
    const t = formatCoffer(x);
    assert.ok(t.startsWith("# Sealed by Coffer"));
    const g = parseCoffer(t.replace(/\n/g, "\r\n"));
    verifyCoffer(g, pq);
    assert.equal(formatCoffer(g), t);
  }
});

test("tampering is caught by the signatures", async () => {
  const f = await base();
  const other = await base();
  const g = await write(f, B, "DATABASE_URL=postgres://attacker\n");
  assert.throws(() => verifyCoffer({ ...f, readers: [A.address, B.address] }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...f, keeper: X.address }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...f, release: other.release }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...f, ownerCopy: other.ownerCopy }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...g, data: f.data }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...g, release: f.release }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...g, writer: C.address }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...g, writer: X.address }, pq), isCode("WRITER_NOT_READER"));
  const { write: _w, ...noWrite } = g;
  assert.throws(() => verifyCoffer(noWrite as CofferFile, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...f, name: ".env.prod" }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer(f, { [B.address]: B.pqKey.publicKey }), isCode("UNKNOWN_KEY"));
});

test("an attacker's look-alike file sealed to the same readers fails verification", async () => {
  const f = await base();
  const evil = await create(X, [A, B, C], "DATABASE_URL=postgres://attacker\n");
  assert.throws(() => verifyCoffer({ ...evil, owner: A.address, writer: A.address, readers: f.readers }, pq), isCode("BAD_SIGNATURE"));
});

test("the chain head decides: old copies and versions, other owners, unrecorded and forked files are refused", async () => {
  const f1 = await base();
  const { file: f2 } = await revokeCoffer(f1, S(A), A.sealKeys, KEEPER, [C.address], names);
  checkHead(f2, headOf(f2));
  assert.throws(() => checkHead(f1, headOf(f2)), isCode("STALE"));
  assert.throws(() => checkHead(f2, null), isCode("UNRECORDED"));
  assert.throws(() => checkHead(f2, headOf(f1)), isCode("UNRECORDED"));
  assert.throws(() => checkHead(f2, { ...headOf(f2), owner: X.address }), isCode("OWNER_MISMATCH"));
  assert.throws(() => checkHead(f2, { ...headOf(f2), access: "0".repeat(64) }), isCode("FORKED"));
  assert.throws(() => checkHead(f2, { ...headOf(f2), data: "0".repeat(64) }), isCode("FORKED"));
  // an older version of the same epoch (a rolled back write) is refused
  const f3 = await write(f2, B, "ROTATED=1\n");
  assert.throws(() => checkHead(f2, headOf(f3)), isCode("STALE"));
});

test("sealed data from another file does not open here", async () => {
  const f = await base();
  const other = await create(A, [B], "X=1\n", ".env.production");
  assert.throws(() => openCoffer({ ...f, data: other.data }, B.sealKeys, ownerRelease(other, A.sealKeys)));
  assert.throws(() => openCoffer({ ...f, key: other.key }, B.sealKeys, ownerRelease(f, A.sealKeys)));
});

test("damaged and earlier-format files give a clear error", async () => {
  const t = formatCoffer(await base());
  assert.throws(() => parseCoffer("hello"), isCode("BAD_FORMAT"));
  assert.throws(() => parseCoffer(t.replace(/^coffer: 4$/m, "coffer: 9")), isCode("BAD_FORMAT"));
  for (const v of ["2", "3"]) assert.throws(() => parseCoffer(t.replace(/^coffer: 4$/m, `coffer: ${v}`)), isCode("OLD_FORMAT"));
  assert.throws(() => parseCoffer(t.replace(/^owner-copy: .*$/m, "")), isCode("BAD_FORMAT"));
});

test("a card signed by a local identity verifies and names its keys; a changed card does not", async () => {
  const card = await signCard(CHAIN, S(B), B.sealKeys);
  const r = readerFromCard({ card, chainId: CHAIN, address: B.address, pqPublicKey: B.pqKey.publicKey, mlkemPublicKey: B.sealKeys.mlkemPublicKey });
  assert.deepEqual(r.x25519PublicKey, B.sealKeys.x25519PublicKey);
  assert.throws(() => readerFromCard({ card, chainId: CHAIN, address: B.address, pqPublicKey: B.pqKey.publicKey, mlkemPublicKey: X.sealKeys.mlkemPublicKey }));
  assert.throws(() => readerFromCard({ card, chainId: CHAIN, address: B.address, pqPublicKey: X.pqKey.publicKey, mlkemPublicKey: B.sealKeys.mlkemPublicKey }));
});

test("a file name with a line break is refused before anything is signed", async () => {
  let signed = 0;
  const counting = { address: A.address, sign: async (c: string, d: Uint8Array) => { signed++; return S(A).sign(c, d); } };
  await assert.rejects(createCoffer({ chainId: CHAIN, name: ".env\nCan open it: everyone", owner: counting, ownerKeys: A.sealKeys, keeper: KEEPER, plaintext: enc.encode(ENV) }), isCode("BAD_NAME"));
  assert.equal(signed, 0);
});

test("a file shared with too many people is refused before the owner signs", async () => {
  let signed = 0;
  const counting = { address: A.address, sign: async (c: string, d: Uint8Array) => { signed++; return S(A).sign(c, d); } };
  const many = Array.from({ length: 12 }, () => identityFromMnemonic(newMnemonic()));
  await assert.rejects(createCoffer({ chainId: CHAIN, name: ".env", owner: counting, ownerKeys: A.sealKeys, keeper: KEEPER, readers: many.map(reader), plaintext: enc.encode(ENV) }), isCode("TOO_MANY_READERS"));
  assert.equal(signed, 0);
  const f = await createCoffer({ chainId: CHAIN, name: ".env", owner: counting, ownerKeys: A.sealKeys, keeper: KEEPER, readers: many.slice(0, 8).map(reader), plaintext: enc.encode(ENV) });
  assert.ok(enc.encode(formatCoffer(f)).length <= 65_536, `${enc.encode(formatCoffer(f)).length} bytes`);
});

test("a write whose owner copy is sealed to the wrong keys does not lock the owner out of share and revoke", async () => {
  const f = await base();
  // a teammate passes its own keys under the owner's address
  const g = await updateCoffer(f, S(B), B.sealKeys, KEEPER, { address: A.address, mlkemPublicKey: B.sealKeys.mlkemPublicKey, x25519PublicKey: B.sealKeys.x25519PublicKey }, enc.encode("X=1\n"));
  verifyCoffer(g, pq);
  assert.throws(() => ownerRelease(g, A.sealKeys), isCode("BAD_RELEASE"));
  // the owner asks the keeper like any reader, and passes that piece on
  const { file } = await revokeCoffer(g, S(A), A.sealKeys, KEEPER, [B.address], names, keeperPiece(g));
  verifyCoffer(file, pq);
  assert.equal(dec.decode(openCoffer(file, A.sealKeys, ownerRelease(file, A.sealKeys))), "X=1\n");
});
