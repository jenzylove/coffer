// Calls into the crypto worker. Errors keep their code (NOT_A_READER, ...).
// One worker per lane: the landing hero runs in its own lane so it never waits
// in line behind heavier work (the try-it demo, the app).
type Lane = "main" | "hero";
const workers = new Map<Lane, Worker>();
let seq = 0;
const waiting = new Map<number, { lane: Lane; ok: (v: any) => void; fail: (e: Error) => void }>();

function failLane(lane: Lane, message: string) {
  for (const [id, w] of waiting) if (w.lane === lane) { w.fail(new Error(message)); waiting.delete(id); }
}

function get(lane: Lane): Worker {
  const have = workers.get(lane);
  if (have) return have;
  const worker = new Worker(new URL("./crypto.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; value?: unknown; message?: string; code?: string }>) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.ok) w.ok(e.data.value);
    else w.fail(Object.assign(new Error(e.data.message ?? "failed"), { code: e.data.code }));
  };
  worker.onerror = (e) => {
    failLane(lane, `The sealing code stopped: ${e.message || "worker error"}`);
    workers.delete(lane);
  };
  workers.set(lane, worker);
  return worker;
}

export function work<T>(op: string, args: unknown = {}, lane: Lane = op.startsWith("hero") ? "hero" : "main"): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { lane, ok, fail });
    get(lane).postMessage({ id, op, args });
  });
}

/** Drop a stuck worker; the next call starts a fresh one. Pending calls fail. */
export function resetWorker(lane: Lane = "hero") {
  workers.get(lane)?.terminate();
  workers.delete(lane);
  failLane(lane, "The sealing code was restarted");
}

/** work(), but give up after `ms` and restart the worker so nothing stays stuck. */
export function workWithin<T>(op: string, args: unknown, ms: number): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const t = setTimeout(() => { resetWorker(op.startsWith("hero") ? "hero" : "main"); fail(Object.assign(new Error("timed out"), { code: "TIMEOUT" })); }, ms);
    work<T>(op, args).then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); });
  });
}
