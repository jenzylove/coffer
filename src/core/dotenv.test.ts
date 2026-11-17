import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDotenv, serializeDotenv, toRecord } from "./dotenv.ts";

const rec = (s: string) => toRecord(parseDotenv(s));

test("blank lines and comments ignored", () => {
  assert.deepEqual(parseDotenv("\n# c\n  # c2\nA=1\n\n"), [{ key: "A", value: "1" }]);
});
test("export prefix, = and : separators", () => {
  assert.deepEqual(rec("export A=1\nB: 2\nC = 3"), { A: "1", B: "2", C: "3" });
});
test("whitespace trimmed", () => {
  assert.deepEqual(rec("  A  =   hello world   \n"), { A: "hello world" });
});
test("inline comments", () => {
  assert.deepEqual(rec("A=val # note\nB=\"x # y\" # c\nC='p # q'"), {
    A: "val",
    B: "x # y",
    C: "p # q",
  });
});
test("single quotes literal", () => {
  assert.equal(rec("A='a\\nb $X'").A, "a\\nb $X");
});
test("double quotes expand \\n and \\r", () => {
  assert.equal(rec('A="a\\nb\\rc"').A, "a\nb\rc");
});
test("double quotes multiline", () => {
  assert.equal(rec('A="line1\nline2"\nB=2').A, "line1\nline2");
  assert.equal(rec('A="line1\nline2"\nB=2').B, "2");
});
test("backticks literal and multiline", () => {
  assert.equal(rec("A=`a\\nb\nc`").A, "a\\nb\nc");
});
test("CRLF input", () => {
  assert.deepEqual(parseDotenv('A=1\r\nB="x\r\ny"\r\nC=3\r\n'), [
    { key: "A", value: "1" },
    { key: "B", value: "x\ny" },
    { key: "C", value: "3" },
  ]);
});
test("duplicates: last value wins, first position kept", () => {
  assert.deepEqual(parseDotenv("A=1\nB=2\nA=3"), [
    { key: "A", value: "3" },
    { key: "B", value: "2" },
  ]);
});
test("malformed lines skipped, empty values kept", () => {
  assert.deepEqual(rec("1BAD=x\nnonsense\nA=\nB=2"), { A: "", B: "2" });
});
test("keys with dots and dashes", () => {
  assert.deepEqual(rec("a.b-c=1"), { "a.b-c": "1" });
});
test("serialize ends with newline, plain when possible", () => {
  assert.equal(serializeDotenv([{ key: "A", value: "x=y" }]), "A=x=y\n");
  assert.equal(serializeDotenv([]), "");
});
test("round trip awkward values", () => {
  const entries = [
    { key: "A", value: 'he said "hi"' },
    { key: "B", value: "a # b" },
    { key: "C", value: "l1\nl2\r\nl3" },
    { key: "D", value: "k=v=w" },
    { key: "E", value: "" },
    { key: "F", value: "héllo 日本 🔐" },
    { key: "G", value: "back\\slash\\" },
    { key: "H", value: "  padded  " },
    { key: "I", value: "it's `x`" },
    { key: "J", value: "\\n literal" },
    { key: "K", value: '"quoted"' },
  ];
  assert.deepEqual(parseDotenv(serializeDotenv(entries)), entries);
});
test("serialize rejects invalid keys", () => {
  assert.throws(() => serializeDotenv([{ key: "bad key", value: "x" }]));
});
