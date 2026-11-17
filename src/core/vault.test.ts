import { test } from "node:test";
import assert from "node:assert/strict";
import { identityFromMnemonic, newMnemonic, type Identity } from "./identity.ts";
import {
  createCoffer, openCoffer, shareCoffer, revokeCoffer, updateCoffer, verifyCoffer,
  formatCoffer, parseCoffer, CofferError, type CofferFile, type Reader,
} from "./vault.ts";

const CHAIN = "qorechain-diana";
const enc = new TextEncoder();
const dec = new TextDecoder();
const ENV = "OPENAI_API_KEY=sk-test-123\nDATABASE_URL=postgres://u:p@db:5432/app\n";

const [A, B, C, X] = [0, 1, 2, 3].map(() => identityFromMnemonic(newMnemonic())) as [Identity, Identity, Identity, Identity];
const reader = (i: Identity): Reader => ({ address: i.address, mlkemPublicKey: i.sealKeys.mlkemPublicKey });
const pq = Object.fromEntries([A, B, C, X].map((i) => [i.address, i.pqKey.publicKey]));
const names = (p: Uint8Array) => dec.decode(p).split("\n").filter(Boolean).map((l) => l.split("=")[0]!);
const code = (c: string) => (e: unknown) => e instanceof CofferError && e.code === c;

function base(): CofferFile {
  return createCoffer({ chainId: CHAIN, name: ".env", owner: A, ownerMlkem: A.sealKeys.mlkemPublicKey, readers: [reader(B), reader(C)], plaintext: enc.encode(ENV) });
}

test("owner and readers open; signatures verify", () => {
  const f = base();
  verifyCoffer(f, pq);
  for (const i of [A, B, C]) assert.equal(dec.decode(openCoffer(f, i.sealKeys)), ENV);
  assert.throws(() => openCoffer(f, X.sealKeys), code("NOT_A_READER"));
  assert.deepEqual(f.readers, [A.address, B.address, C.address].sort());
});

test("share adds a reader in a new epoch", () => {
  const f0 = createCoffer({ chainId: CHAIN, name: ".env", owner: A, ownerMlkem: A.sealKeys.mlkemPublicKey, plaintext: enc.encode(ENV) });
  assert.throws(() => openCoffer(f0, B.sealKeys), code("NOT_A_READER"));
  const f1 = shareCoffer(f0, A, A.sealKeys, [reader(B)]);
  verifyCoffer(f1, pq);
  assert.ok(f1.epoch > f0.epoch);
  assert.equal(dec.decode(openCoffer(f1, B.sealKeys)), ENV);
  // the new reader's key does not open the earlier epoch's envelope
  assert.throws(() => openCoffer({ ...f1, key: f0.key }, B.sealKeys), code("NOT_A_READER"));
});

test("revoke locks a reader out of the new epoch and lists keys to rotate", () => {
  const f = base();
  const { file, rotate } = revokeCoffer(f, A, A.sealKeys, [C.address], names);
  verifyCoffer(file, pq);
  assert.deepEqual(rotate, ["OPENAI_API_KEY", "DATABASE_URL"]);
  assert.equal(dec.decode(openCoffer(file, B.sealKeys)), ENV);
  assert.throws(() => openCoffer(file, C.sealKeys), code("NOT_A_READER"));
  assert.ok(!file.readers.includes(C.address));
  // C keeps what it already saw: revoke cannot un-reveal
  assert.equal(dec.decode(openCoffer(f, C.sealKeys)), ENV);
});

test("only the owner can share or revoke; the owner cannot be removed", () => {
  const f = base();
  assert.throws(() => shareCoffer(f, B, B.sealKeys, [reader(X)]), code("NOT_OWNER"));
  assert.throws(() => revokeCoffer(f, B, B.sealKeys, [C.address], names), code("NOT_OWNER"));
  assert.throws(() => revokeCoffer(f, A, A.sealKeys, [A.address], names), code("OWNER_NOT_MEMBER"));
  assert.throws(() => revokeCoffer(f, A, A.sealKeys, [X.address], names), code("NOT_A_READER"));
  // B pretending to be owner with B's own keys cannot open the admin state
  assert.throws(() => shareCoffer({ ...f, owner: B.address }, B, B.sealKeys, [reader(X)]), (e) => e instanceof CofferError);
});

test("a reader can update contents; a non-reader cannot", () => {
  const f = base();
  const g = updateCoffer(f, B, B.sealKeys, enc.encode(ENV + "NEW=1\n"));
  verifyCoffer(g, pq);
  assert.equal(g.writer, B.address);
  assert.equal(g.version, f.version + 1n);
  assert.equal(dec.decode(openCoffer(g, C.sealKeys)), ENV + "NEW=1\n");
  assert.throws(() => updateCoffer(f, X, X.sealKeys, enc.encode("x")), code("NOT_A_READER"));
});

test("text format round-trips", () => {
  const f = base();
  const t = formatCoffer(f);
  assert.ok(t.startsWith("# Sealed by Coffer"));
  const g = parseCoffer(t.replace(/\n/g, "\r\n"));
  verifyCoffer(g, pq);
  assert.equal(dec.decode(openCoffer(g, B.sealKeys)), ENV);
  assert.equal(formatCoffer(g), t);
});

test("tampering is caught by the signatures", () => {
  const f = base();
  const g = updateCoffer(f, B, B.sealKeys, enc.encode("DATABASE_URL=postgres://attacker\n"));
  // readers list edited by hand
  assert.throws(() => verifyCoffer({ ...f, readers: [A.address, B.address] }, pq), code("BAD_SIGNATURE"));
  // newer data swapped for older data (rollback of contents inside one epoch)
  assert.throws(() => verifyCoffer({ ...g, data: f.data }, pq), code("BAD_SIGNATURE"));
  // writer claims to be someone else
  assert.throws(() => verifyCoffer({ ...g, writer: C.address }, pq), code("BAD_SIGNATURE"));
  // a non-reader writes and signs with its own key
  assert.throws(() => verifyCoffer({ ...g, writer: X.address }, pq), code("WRITER_NOT_READER"));
  // signer key not known on chain
  assert.throws(() => verifyCoffer(f, { [B.address]: B.pqKey.publicKey }), code("UNKNOWN_KEY"));
});

test("an attacker's look-alike file sealed to the same readers fails verification", () => {
  const f = base();
  // X builds a valid file of its own, then relabels the owner and writer as A
  const evil = createCoffer({ chainId: CHAIN, name: ".env", owner: X, ownerMlkem: X.sealKeys.mlkemPublicKey, readers: [reader(A), reader(B), reader(C)], plaintext: enc.encode("DATABASE_URL=postgres://attacker\n") });
  const forged = { ...evil, owner: A.address, writer: A.address, readers: f.readers };
  assert.throws(() => verifyCoffer(forged, pq), code("BAD_SIGNATURE"));
});

test("sealed data from another file does not open here", () => {
  const f = base();
  const other = createCoffer({ chainId: CHAIN, name: ".env.production", owner: A, ownerMlkem: A.sealKeys.mlkemPublicKey, readers: [reader(B)], plaintext: enc.encode("X=1\n") });
  assert.throws(() => openCoffer({ ...f, data: other.data }, B.sealKeys));
  assert.throws(() => openCoffer({ ...f, key: other.key }, B.sealKeys));
});

test("damaged files give a clear error", () => {
  assert.throws(() => parseCoffer("hello"), code("BAD_FORMAT"));
  assert.throws(() => parseCoffer(formatCoffer(base()).replace(/^coffer: 1$/m, "coffer: 9")), code("BAD_FORMAT"));
  assert.throws(() => parseCoffer(formatCoffer(base()).replace(/^data: .*$/m, "")), code("BAD_FORMAT"));
});
