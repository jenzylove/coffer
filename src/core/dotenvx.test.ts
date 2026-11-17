import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { importDotenvx, scanDotenvx } from "./dotenvx.ts";
import { toRecord } from "./dotenv.ts";

const CLI = join(process.cwd(), "node_modules", "@dotenvx", "dotenvx", "src", "cli", "dotenvx.js");
let dir = "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "coffer-dotenvx-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Encrypt `content` as `file` in a fresh subfolder with the real dotenvx CLI. */
function encryptWithDotenvx(sub: string, file: string, content: string) {
  const cwd = join(dir, sub);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, file), content);
  const r = spawnSync(process.execPath, [CLI, "encrypt", "-f", file], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return {
    env: readFileSync(join(cwd, file), "utf8"),
    keys: readFileSync(join(cwd, ".env.keys"), "utf8"),
  };
}

const SOURCE = [
  "API_KEY=sk-live-123",
  'MULTI="line one\\nline two"',
  "HAS_EQ=a=b=c",
  "EMPTY=",
  'UNICODE="héllo 日本 🔐"',
  "# a comment",
  "",
].join("\n");
const EXPECTED = {
  API_KEY: "sk-live-123",
  MULTI: "line one\nline two",
  HAS_EQ: "a=b=c",
  EMPTY: "",
  UNICODE: "héllo 日本 🔐",
};

test("imports a real dotenvx encrypted .env", () => {
  const { env, keys } = encryptWithDotenvx("plain", ".env", SOURCE);
  assert.match(env, /encrypted:/);
  const res = importDotenvx(env, keys);
  assert.deepEqual(toRecord(res.entries), EXPECTED);
  assert.equal(res.environment, undefined);
  assert.match(res.publicKey, /^0[23][0-9a-f]{64}$/);
  assert.ok(!res.entries.some((e) => e.key.startsWith("DOTENV_PUBLIC_KEY")));
});

test("imports an environment suffixed file (.env.production)", () => {
  const { env, keys } = encryptWithDotenvx("prod", ".env.production", SOURCE);
  assert.match(env, /DOTENV_PUBLIC_KEY_PRODUCTION=/);
  assert.match(keys, /DOTENV_PRIVATE_KEY_PRODUCTION=/);
  const res = importDotenvx(env, keys);
  assert.equal(res.environment, "production");
  assert.deepEqual(toRecord(res.entries), EXPECTED);
});

test("picks the matching key out of a multi environment .env.keys", () => {
  const a = encryptWithDotenvx("multi-a", ".env", "A=1\n");
  const b = encryptWithDotenvx("multi-b", ".env.production", "B=2\n");
  const keys = a.keys + "\n" + b.keys;
  assert.deepEqual(toRecord(importDotenvx(b.env, keys).entries), { B: "2" });
  assert.deepEqual(toRecord(importDotenvx(a.env, keys).entries), { A: "1" });
});

test("wrong .env.keys throws without leaking secrets", () => {
  const one = encryptWithDotenvx("wrong-1", ".env", SOURCE);
  const other = encryptWithDotenvx("wrong-2", ".env", "X=1\n");
  const otherPriv = /DOTENV_PRIVATE_KEY="?([0-9a-f]+)/.exec(other.keys)?.[1] as string;
  assert.ok(otherPriv);
  assert.throws(
    () => importDotenvx(one.env, other.keys),
    (err: Error) => {
      assert.match(err.message, /No private key/);
      assert.ok(!err.message.includes(otherPriv));
      assert.ok(!err.message.includes("sk-live-123"));
      return true;
    },
  );
  assert.throws(() => importDotenvx(one.env, ""), /No private key/);
});

test("a damaged value names the key but not its contents", () => {
  const { env, keys } = encryptWithDotenvx("damaged", ".env", "TOKEN=secretvalue\n");
  const bad = env.replace(/TOKEN=encrypted:(\S{8})/, "TOKEN=encrypted:AAAAAAAA");
  assert.notEqual(bad, env);
  assert.throws(
    () => importDotenvx(bad, keys),
    (err: Error) => {
      assert.match(err.message, /TOKEN/);
      assert.ok(!err.message.includes("secretvalue"));
      return true;
    },
  );
});

test("non dotenvx input is rejected by importDotenvx", () => {
  assert.throws(() => importDotenvx("A=1\n", ""), /dotenvx/);
});

test("scanDotenvx on a plain .env", () => {
  const s = scanDotenvx("A=1\nB=two\n");
  assert.equal(s.isDotenvx, false);
  assert.deepEqual(s.encryptedKeys, []);
  assert.deepEqual(s.plainKeys, ["A", "B"]);
  assert.equal(s.publicKey, undefined);
  assert.equal(s.curve, "secp256k1");
});

test("scanDotenvx on encrypted files", () => {
  const { env } = encryptWithDotenvx("scan", ".env.production", SOURCE);
  const s = scanDotenvx(env);
  assert.equal(s.isDotenvx, true);
  assert.equal(s.publicKeyName, "DOTENV_PUBLIC_KEY_PRODUCTION");
  assert.equal(s.environment, "production");
  assert.match(s.publicKey ?? "", /^0[23][0-9a-f]{64}$/);
  assert.deepEqual(s.encryptedKeys.sort(), ["API_KEY", "EMPTY", "HAS_EQ", "MULTI", "UNICODE"].sort());
  assert.deepEqual(s.plainKeys, []);

  const plainName = scanDotenvx(encryptWithDotenvx("scan2", ".env", "A=1\n").env);
  assert.equal(plainName.publicKeyName, "DOTENV_PUBLIC_KEY");
  assert.equal(plainName.environment, undefined);
});

test("scanDotenvx flags encrypted values even without a public key line", () => {
  const s = scanDotenvx("A=encrypted:abc\nB=1\n");
  assert.equal(s.isDotenvx, true);
  assert.deepEqual(s.encryptedKeys, ["A"]);
  assert.deepEqual(s.plainKeys, ["B"]);
});
