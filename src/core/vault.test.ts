import { test } from "node:test";
import assert from "node:assert/strict";
import { identityFromMnemonic, newMnemonic, type Identity } from "./identity.ts";
import {
  createCoffer, openCoffer, shareCoffer, revokeCoffer, updateCoffer, verifyCoffer, checkHead, headArgs, accessHash,
  changeText, localSigner, formatCoffer, parseCoffer, CofferError, type CofferFile, type Reader, type ChainHead,
} from "./vault.ts";
import { signCard, readerFromCard } from "./card.ts";

const CHAIN = "qorechain-diana";
const enc = new TextEncoder();
const dec = new TextDecoder();
const ENV = "OPENAI_API_KEY=sk-test-123\nDATABASE_URL=postgres://u:p@db:5432/app\n";

const [A, B, C, X] = [0, 1, 2, 3].map(() => identityFromMnemonic(newMnemonic())) as [Identity, Identity, Identity, Identity];
const reader = (i: Identity): Reader => ({ address: i.address, mlkemPublicKey: i.sealKeys.mlkemPublicKey, x25519PublicKey: i.sealKeys.x25519PublicKey });
const S = (i: Identity) => localSigner(i);
const pq = Object.fromEntries([A, B, C, X].map((i) => [i.address, i.pqKey.publicKey]));
const names = (p: Uint8Array) => dec.decode(p).split("\n").filter(Boolean).map((l) => l.split("=")[0]!);
const isCode = (c: string) => (e: unknown) => e instanceof CofferError && e.code === c;

const create = (owner: Identity, readers: Identity[] = [], plaintext = ENV, name = ".env") =>
  createCoffer({ chainId: CHAIN, name, owner: S(owner), ownerKeys: owner.sealKeys, readers: readers.map(reader), plaintext: enc.encode(plaintext) });
const base = () => create(A, [B, C]);
const headOf = (f: CofferFile): ChainHead => ({ owner: f.owner, epoch: f.epoch, version: f.change.version, access: accessHash(f), data: f.change.data, height: 1 });

test("owner and readers open; signatures verify", async () => {
  const f = await base();
  verifyCoffer(f, pq);
  for (const i of [A, B, C]) assert.equal(dec.decode(openCoffer(f, i.sealKeys)), ENV);
  assert.throws(() => openCoffer(f, X.sealKeys), isCode("NOT_A_READER"));
  assert.deepEqual(f.readers, [A.address, B.address, C.address].sort());
  assert.match(f.id, /^[0-9a-f]{32}$/);
});

test("the owner signs one change, and it is the text the contract checks", async () => {
  const signed: string[] = [];
  const counting = { address: A.address, sign: async (chainId: string, data: Uint8Array) => { signed.push(dec.decode(data)); return S(A).sign(chainId, data); } };
  const f = await createCoffer({ chainId: CHAIN, name: ".env", owner: counting, ownerKeys: A.sealKeys, readers: [reader(B)], plaintext: enc.encode(ENV) });
  assert.equal(signed.length, 1);
  const h = headArgs(f);
  assert.equal(signed[0], changeText({ id: h.file, epoch: h.epoch, version: h.version, access: h.access, data: h.data, name: h.name, readers: h.readers }));
  assert.match(signed[0]!, /^Coffer change v1\nFile: [0-9a-f]{32}\nEpoch: \d+\nVersion: 1\nAccess: [0-9a-f]{64}\nData: [0-9a-f]{64}\nName: \.env\nCan open it: qor1\w+, qor1\w+\nSign this only on coffer\.jdollar\.site\.$/);
  assert.ok(signed[0]!.includes(B.address) && signed[0]!.includes(A.address));
  assert.equal(h.pqSig, f.change.sig.pq?.signature);
});

test("share adds a reader in a new epoch", async () => {
  const f0 = await create(A);
  assert.throws(() => openCoffer(f0, B.sealKeys), isCode("NOT_A_READER"));
  const f1 = await shareCoffer(f0, S(A), A.sealKeys, [reader(B)]);
  verifyCoffer(f1, pq);
  assert.ok(f1.epoch > f0.epoch);
  assert.equal(dec.decode(openCoffer(f1, B.sealKeys)), ENV);
  assert.throws(() => openCoffer({ ...f1, key: f0.key }, B.sealKeys), isCode("NOT_A_READER"));
});

test("share with a reader's new card replaces their keys", async () => {
  const f0 = await base();
  const B2 = identityFromMnemonic(newMnemonic());
  const moved: Reader = { address: B.address, mlkemPublicKey: B2.sealKeys.mlkemPublicKey, x25519PublicKey: B2.sealKeys.x25519PublicKey };
  const f1 = await shareCoffer(f0, S(A), A.sealKeys, [moved]);
  assert.equal(dec.decode(openCoffer(f1, B2.sealKeys)), ENV);
  assert.throws(() => openCoffer(f1, B.sealKeys), isCode("NOT_A_READER"));
  assert.deepEqual(f1.readers, f0.readers);
});

test("revoke locks a reader out of the new epoch and lists keys to rotate", async () => {
  const f = await base();
  const { file, rotate } = await revokeCoffer(f, S(A), A.sealKeys, [C.address], names);
  verifyCoffer(file, pq);
  assert.deepEqual(rotate, ["OPENAI_API_KEY", "DATABASE_URL"]);
  assert.equal(dec.decode(openCoffer(file, B.sealKeys)), ENV);
  assert.throws(() => openCoffer(file, C.sealKeys), isCode("NOT_A_READER"));
  assert.ok(!file.readers.includes(C.address));
  assert.equal(dec.decode(openCoffer(f, C.sealKeys)), ENV); // revoke cannot un-reveal
});

test("only the owner can share or revoke; the owner cannot be removed", async () => {
  const f = await base();
  await assert.rejects(shareCoffer(f, S(B), B.sealKeys, [reader(X)]), isCode("NOT_OWNER"));
  await assert.rejects(revokeCoffer(f, S(B), B.sealKeys, [C.address], names), isCode("NOT_OWNER"));
  await assert.rejects(revokeCoffer(f, S(A), A.sealKeys, [A.address], names), isCode("OWNER_NOT_MEMBER"));
  await assert.rejects(revokeCoffer(f, S(A), A.sealKeys, [X.address], names), isCode("NOT_A_READER"));
  await assert.rejects(shareCoffer({ ...f, owner: B.address }, S(B), B.sealKeys, [reader(X)]), (e) => e instanceof CofferError);
});

test("a reader can update contents; a non-reader cannot", async () => {
  const f = await base();
  const g = await updateCoffer(f, S(B), B.sealKeys, enc.encode(ENV + "NEW=1\n"));
  verifyCoffer(g, pq);
  assert.equal(g.writer, B.address);
  assert.equal(g.version, f.version + 1n);
  assert.ok(g.write);
  assert.equal(dec.decode(openCoffer(g, C.sealKeys)), ENV + "NEW=1\n");
  await assert.rejects(updateCoffer(f, S(X), X.sealKeys, enc.encode("x")), isCode("NOT_A_READER"));
  // the owner's change still covers the access block, so the chain head still matches
  checkHead(g, headOf(f));
});

test("text format round-trips, with and without a write", async () => {
  const f = await base();
  for (const x of [f, await updateCoffer(f, S(B), B.sealKeys, enc.encode("Z=1\n"))]) {
    const t = formatCoffer(x);
    assert.ok(t.startsWith("# Sealed by Coffer"));
    const g = parseCoffer(t.replace(/\n/g, "\r\n"));
    verifyCoffer(g, pq);
    assert.equal(formatCoffer(g), t);
  }
});

test("tampering is caught by the signatures", async () => {
  const f = await base();
  const g = await updateCoffer(f, S(B), B.sealKeys, enc.encode("DATABASE_URL=postgres://attacker\n"));
  assert.throws(() => verifyCoffer({ ...f, readers: [A.address, B.address] }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...g, data: f.data }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...g, writer: C.address }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer({ ...g, writer: X.address }, pq), isCode("WRITER_NOT_READER"));
  // dropping the write and keeping the new data does not pass as the owner's version
  const { write: _w, ...noWrite } = g;
  assert.throws(() => verifyCoffer(noWrite as CofferFile, pq), isCode("BAD_SIGNATURE"));
  // the name the owner read is part of what they signed
  assert.throws(() => verifyCoffer({ ...f, name: ".env.prod" }, pq), isCode("BAD_SIGNATURE"));
  assert.throws(() => verifyCoffer(f, { [B.address]: B.pqKey.publicKey }), isCode("UNKNOWN_KEY"));
});

test("an attacker's look-alike file sealed to the same readers fails verification", async () => {
  const f = await base();
  const evil = await create(X, [A, B, C], "DATABASE_URL=postgres://attacker\n");
  const forged = { ...evil, owner: A.address, writer: A.address, readers: f.readers };
  assert.throws(() => verifyCoffer(forged, pq), isCode("BAD_SIGNATURE"));
});

test("the chain head decides: old copies, other owners, unrecorded and forked files are refused", async () => {
  const f1 = await base();
  const { file: f2 } = await revokeCoffer(f1, S(A), A.sealKeys, [C.address], names);
  checkHead(f2, headOf(f2));
  assert.throws(() => checkHead(f1, headOf(f2)), isCode("STALE")); // the copy C can still open
  assert.throws(() => checkHead(f2, null), isCode("UNRECORDED"));
  assert.throws(() => checkHead(f2, headOf(f1)), isCode("UNRECORDED"));
  assert.throws(() => checkHead(f2, { ...headOf(f2), owner: X.address }), isCode("OWNER_MISMATCH"));
  assert.throws(() => checkHead(f2, { ...headOf(f2), access: "0".repeat(64) }), isCode("FORKED"));
});

test("sealed data from another file does not open here", async () => {
  const f = await base();
  const other = await create(A, [B], "X=1\n", ".env.production");
  assert.throws(() => openCoffer({ ...f, data: other.data }, B.sealKeys));
  assert.throws(() => openCoffer({ ...f, key: other.key }, B.sealKeys));
});

test("damaged and first-format files give a clear error", async () => {
  const t = formatCoffer(await base());
  assert.throws(() => parseCoffer("hello"), isCode("BAD_FORMAT"));
  assert.throws(() => parseCoffer(t.replace(/^coffer: 2$/m, "coffer: 9")), isCode("BAD_FORMAT"));
  assert.throws(() => parseCoffer(t.replace(/^coffer: 2$/m, "coffer: 1")), isCode("OLD_FORMAT"));
  assert.throws(() => parseCoffer(t.replace(/^data: .*$/m, "")), isCode("BAD_FORMAT"));
});

test("a card signed by a local identity verifies and names its keys; a changed card does not", async () => {
  const card = await signCard(CHAIN, S(B), B.sealKeys);
  const r = readerFromCard({ card, chainId: CHAIN, address: B.address, pqPublicKey: B.pqKey.publicKey, mlkemPublicKey: B.sealKeys.mlkemPublicKey });
  assert.deepEqual(r.x25519PublicKey, B.sealKeys.x25519PublicKey);
  assert.throws(() => readerFromCard({ card, chainId: CHAIN, address: B.address, pqPublicKey: B.pqKey.publicKey, mlkemPublicKey: X.sealKeys.mlkemPublicKey }));
  assert.throws(() => readerFromCard({ card: { ...card, x25519PublicKey: Buffer.from(X.sealKeys.x25519PublicKey).toString("hex") }, chainId: CHAIN, address: B.address, pqPublicKey: B.pqKey.publicKey, mlkemPublicKey: B.sealKeys.mlkemPublicKey }));
  assert.throws(() => readerFromCard({ card, chainId: CHAIN, address: B.address, pqPublicKey: X.pqKey.publicKey, mlkemPublicKey: B.sealKeys.mlkemPublicKey }));
  // a file sealed to the card's keys opens with B's keys
  const f = await createCoffer({ chainId: CHAIN, name: ".env", owner: S(A), ownerKeys: A.sealKeys, readers: [r], plaintext: enc.encode(ENV) });
  assert.equal(dec.decode(openCoffer(f, B.sealKeys)), ENV);
});

test("a file name with a line break is refused before anything is signed", async () => {
  let signed = 0;
  const counting = { address: A.address, sign: async (c: string, d: Uint8Array) => { signed++; return S(A).sign(c, d); } };
  await assert.rejects(createCoffer({ chainId: CHAIN, name: ".env\nCan open it: everyone", owner: counting, ownerKeys: A.sealKeys, plaintext: enc.encode(ENV) }), isCode("BAD_NAME"));
  assert.equal(signed, 0);
});

test("a file shared with too many people is refused before the owner signs", async () => {
  let signed = 0;
  const counting = { address: A.address, sign: async (c: string, d: Uint8Array) => { signed++; return S(A).sign(c, d); } };
  const many = Array.from({ length: 12 }, () => identityFromMnemonic(newMnemonic()));
  await assert.rejects(createCoffer({ chainId: CHAIN, name: ".env", owner: counting, ownerKeys: A.sealKeys, readers: many.map(reader), plaintext: enc.encode(ENV) }), isCode("TOO_MANY_READERS"));
  assert.equal(signed, 0);
  // ten people (owner plus nine) still fit, and the real file is under the contract's limit
  const f = await createCoffer({ chainId: CHAIN, name: ".env", owner: counting, ownerKeys: A.sealKeys, readers: many.slice(0, 9).map(reader), plaintext: enc.encode(ENV) });
  assert.ok(enc.encode(formatCoffer(f)).length <= 65_536, `${enc.encode(formatCoffer(f)).length} bytes`);
});
