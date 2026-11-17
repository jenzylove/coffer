import { test } from "node:test";
import assert from "node:assert/strict";
import { grantMemos, parseGrantMemo, fileId } from "./qore.ts";

const addr = (i: number) => `qor1${String(i).repeat(38).slice(0, 38).replace(/[1bio]/g, "q")}`;

test("grant memo round-trips and stays under 256 characters", () => {
  const g = { op: "share" as const, fileId: fileId("qor1owner", ".env"), epoch: 7n, version: 12n, added: [0, 2, 3, 4, 5, 6].map(addr), removed: [7, 8].map(addr) };
  const memos = grantMemos(g);
  assert.ok(memos.length > 1);
  for (const m of memos) assert.ok(m.length <= 256, `${m.length}`);
  const back = memos.map((m) => parseGrantMemo(m)!);
  assert.deepEqual(back.flatMap((b) => b.added), g.added);
  assert.deepEqual(back.flatMap((b) => b.removed), g.removed);
  for (const b of back) { assert.equal(b.epoch, 7n); assert.equal(b.version, 12n); assert.equal(b.fileId, g.fileId); }
});

test("other memos are ignored", () => {
  assert.equal(parseGrantMemo(""), null);
  assert.equal(parseGrantMemo("coffer grant v1 file=spike"), null);
  assert.equal(parseGrantMemo("coffer/1 share zz e1 v1"), null);
});

test("file id depends on owner and name", () => {
  assert.notEqual(fileId("qor1a", ".env"), fileId("qor1b", ".env"));
  assert.notEqual(fileId("qor1a", ".env"), fileId("qor1a", ".env.production"));
  assert.match(fileId("qor1a", ".env"), /^[0-9a-f]{12}$/);
});
