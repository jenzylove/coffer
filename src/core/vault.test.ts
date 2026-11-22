import { test } from "node:test";
import assert from "node:assert/strict";
import { identityFromMnemonic, newMnemonic, type Identity } from "./identity.ts";
import {
  createCoffer, openCoffer, shareCoffer, revokeCoffer, updateCoffer, verifyCoffer, checkHead, headArgs, accessHash,
  changeText, openText, deviceText, deviceId, localSigner, formatCoffer, parseCoffer, CofferError, canRead, ownerRelease,
  keeperOpenRelease, sealReleaseTo, openReleaseTo, signOpen, newDeviceKey, newNonce,
  type CofferFile, type Reader, type ChainHead,
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
const headOf = (f: CofferFile): ChainHead => ({ owner: f.owner, epoch: f.epoch, version: f.change.version, access: accessHash(f), data: f.change.data, height: 1 });

/** The whole open path a reader goes through: signed request, keeper unwraps, seals to the reader, reader opens. */
function openVia(f: CofferFile, who: Identity): string {
  const nonce = newNonce();
  const r = keeperOpenRelease({ chainId: CHAIN, file: f.id, epoch: f.epoch, envelope: f.release, keeperKeys: K.sealKeys });
  const sealed = sealReleaseTo({ chainId: CHAIN, file: f.id, epoch: f.epoch, reader: reader(who), nonce, release: r });
  const mine = openReleaseTo({ chainId: CHAIN, file: f.id, epoch: f.epoch, reader: who.address, nonce, sealed, keys: who.sealKeys });
  return dec.decode(openCoffer(f, who.sealKeys, mine));
}

test("readers open through the keeper; signatures verify", async () => {
  const f = await base();
  verifyCoffer(f, pq);
  for (const i of [A, B, C]) assert.equal(openVia(f, i), ENV);
  assert.equal(f.keeper, K.address);
  assert.throws(() => openVia(f, X), isCode("NOT_A_READER"));
  assert.ok(canRead(f, B.sealKeys) && !canRead(f, X.sealKeys));
  assert.match(f.id, /^[0-9a-f]{32}$/);
});

test("a reader's own key is not enough: the release piece is needed", async () => {
  const f = await base();
  const wrong = crypto.getRandomValues(new Uint8Array(32));
  assert.throws(() => openCoffer(f, B.sealKeys, wrong), isCode("BAD_RELEASE"));
  // and the keeper alone cannot read: its key is not a reader's
  const r = keeperOpenRelease({ chainId: CHAIN, file: f.id, epoch: f.epoch, envelope: f.release, keeperKeys: K.sealKeys });
  assert.throws(() => openCoffer(f, K.sealKeys, r), isCode("NOT_A_READER"));
});

test("a release piece is bound to its file and epoch, and a sealed release to its reader and request", async () => {
  const f = await base();
  const g = await base();
  assert.throws(() => keeperOpenRelease({ chainId: CHAIN, file: g.id, epoch: g.epoch, envelope: f.release, keeperKeys: K.sealKeys }), isCode("BAD_RELEASE"));
  assert.throws(() => keeperOpenRelease({ chainId: CHAIN, file: f.id, epoch: f.epoch + 1n, envelope: f.release, keeperKeys: K.sealKeys }), isCode("BAD_RELEASE"));
  assert.throws(() => keeperOpenRelease({ chainId: CHAIN, file: f.id, epoch: f.epoch, envelope: f.release, keeperKeys: X.sealKeys }), isCode("BAD_RELEASE"));
  const r = keeperOpenRelease({ chainId: CHAIN, file: f.id, epoch: f.epoch, envelope: f.release, keeperKeys: K.sealKeys });
  const sealed = sealReleaseTo({ chainId: CHAIN, file: f.id, epoch: f.epoch, reader: reader(B), nonce: 7n, release: r });
  assert.throws(() => openReleaseTo({ chainId: CHAIN, file: f.id, epoch: f.epoch, reader: B.address, nonce: 8n, sealed, keys: B.sealKeys }), isCode("BAD_RELEASE"));
  assert.throws(() => openReleaseTo({ chainId: CHAIN, file: f.id, epoch: f.epoch, reader: C.address, nonce: 7n, sealed, keys: C.sealKeys }), isCode("BAD_RELEASE"));
});

test("the owner opens with its own copy of the release piece", async () => {
  const f = await base();
  assert.equal(dec.decode(openCoffer(f, A.sealKeys, ownerRelease(f, A.sealKeys))), ENV);
  assert.throws(() => ownerRelease(f, B.sealKeys), isCode("NOT_OWNER"));
});

test("the owner signs one change, and it is the text the contract checks", async () => {
  const signed: string[] = [];
  const counting = { address: A.address, sign: async (chainId: string, data: Uint8Array) => { signed.push(dec.decode(data)); return S(A).sign(chainId, data); } };
  const f = await createCoffer({ chainId: CHAIN, name: ".env", owner: counting, ownerKeys: A.sealKeys, keeper: KEEPER, readers: [reader(B)], plaintext: enc.encode(ENV) });
  assert.equal(signed.length, 1);
  const h = headArgs(f);
  assert.equal(signed[0], changeText({ id: h.file, epoch: h.epoch, version: h.version, access: h.access, data: h.data, name: h.name, readers: h.readers }));
  assert.match(signed[0]!, /^Coffer change v1\nFile: [0-9a-f]{32}\nEpoch: \d+\nVersion: 1\nAccess: [0-9a-f]{64}\nData: [0-9a-f]{64}\nName: \.env\nCan open it: qor1\w+, qor1\w+\nSign this only on coffer\.jdollar\.site\.$/);
});

test("open requests: the exact text, signed by the reader or by an approved device", async () => {
  const req = { file: "00112233445566778899aabbccddeeff", epoch: 3n, reader: B.address, nonce: 42n };
  assert.equal(openText(req), `Coffer open v1\nFile: 00112233445566778899aabbccddeeff\nEpoch: 3\nReader: ${B.address}\nNonce: 42\nSign this only on coffer.jdollar.site.`);
  const byAccount = await signOpen(CHAIN, req, { account: S(B) });
  assert.ok(pqVerify(B.pqKey.publicKey, messagePqSignBytes(CHAIN, openText(req)), byAccount));
  await assert.rejects(signOpen(CHAIN, req, { account: S(C) }), isCode("NOT_A_READER"));
  const device = newDeviceKey();
  const byDevice = await signOpen(CHAIN, req, { device });
  assert.ok(pqVerify(device.publicKey, messagePqSignBytes(CHAIN, openText(req)), byDevice));
  assert.ok(!pqVerify(device.publicKey, messagePqSignBytes(CHAIN, openText({ ...req, nonce: 43n })), byDevice));
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
  assert.ok(f1.epoch > f0.epoch);
  assert.equal(openVia(f1, B), ENV);
  assert.throws(() => openVia({ ...f1, key: f0.key }, B), isCode("NOT_A_READER"));
  assert.notDeepEqual(f1.release, f0.release);
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
  assert.equal(openVia(file, B), ENV);
  assert.throws(() => openVia(file, C), isCode("NOT_A_READER"));
  assert.ok(!file.readers.includes(C.address));
  // C still holds its own piece of the old copy; without the release piece (the contract refuses it, see Coffer.t.sol) that is just ciphertext
  assert.ok(canRead(f, C.sealKeys));
});

test("only the owner can share or revoke; the owner cannot be removed", async () => {
  const f = await base();
  await assert.rejects(shareCoffer(f, S(B), B.sealKeys, KEEPER, [reader(X)]), isCode("NOT_OWNER"));
  await assert.rejects(revokeCoffer(f, S(B), B.sealKeys, KEEPER, [C.address], names), isCode("NOT_OWNER"));
  await assert.rejects(revokeCoffer(f, S(A), A.sealKeys, KEEPER, [A.address], names), isCode("OWNER_NOT_MEMBER"));
  await assert.rejects(revokeCoffer(f, S(A), A.sealKeys, KEEPER, [X.address], names), isCode("NOT_A_READER"));
});

test("a reader can update contents with an open's release piece; a non-reader cannot", async () => {
  const f = await base();
  const r = keeperOpenRelease({ chainId: CHAIN, file: f.id, epoch: f.epoch, envelope: f.release, keeperKeys: K.sealKeys });
  const g = await updateCoffer(f, S(B), B.sealKeys, r, enc.encode(ENV + "NEW=1\n"));
  verifyCoffer(g, pq);
  assert.equal(g.writer, B.address);
  assert.equal(openVia(g, C), ENV + "NEW=1\n");
  await assert.rejects(updateCoffer(f, S(X), X.sealKeys, r, enc.encode("x")), isCode("NOT_A_READER"));
  await assert.rejects(updateCoffer(f, S(B), B.sealKeys, crypto.getRandomValues(new Uint8Array(32)), enc.encode("x")), isCode("BAD_RELEASE"));
  checkHead(g, headOf(f));
});

test("text format round-trips, with and without a write", async () => {
  const f = await base();
  const r = ownerRelease(f, A.sealKeys);
  for (const x of [f, await updateCoffer(f, S(B), B.sealKeys, r, enc.encode("Z=1\n"))]) {
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
  const g = await updateCoffer(f, S(B), B.sealKeys, ownerRelease(f, A.sealKeys), enc.encode("DATABASE_URL=postgres://attacker\n"));
  assert.throws(() => verifyCoffer({ ...f, readers: [A.address, B.address] }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...f, keeper: X.address }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...f, release: other.release }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...g, data: f.data }, pq), isCode("BAD_SIGNATURE"));
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

test("the chain head decides: old copies, other owners, unrecorded and forked files are refused", async () => {
  const f1 = await base();
  const { file: f2 } = await revokeCoffer(f1, S(A), A.sealKeys, KEEPER, [C.address], names);
  checkHead(f2, headOf(f2));
  assert.throws(() => checkHead(f1, headOf(f2)), isCode("STALE"));
  assert.throws(() => checkHead(f2, null), isCode("UNRECORDED"));
  assert.throws(() => checkHead(f2, headOf(f1)), isCode("UNRECORDED"));
  assert.throws(() => checkHead(f2, { ...headOf(f2), owner: X.address }), isCode("OWNER_MISMATCH"));
  assert.throws(() => checkHead(f2, { ...headOf(f2), access: "0".repeat(64) }), isCode("FORKED"));
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
  assert.throws(() => parseCoffer(t.replace(/^coffer: 3$/m, "coffer: 9")), isCode("BAD_FORMAT"));
  assert.throws(() => parseCoffer(t.replace(/^coffer: 3$/m, "coffer: 2")), isCode("OLD_FORMAT"));
  assert.throws(() => parseCoffer(t.replace(/^release: .*$/m, "")), isCode("BAD_FORMAT"));
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
