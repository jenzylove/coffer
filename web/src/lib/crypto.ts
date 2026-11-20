// Calls into the crypto worker. Errors keep their code (NOT_A_READER, ...).
let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();

function get(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./crypto.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; value?: unknown; message?: string; code?: string }>) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.ok) w.ok(e.data.value);
    else w.fail(Object.assign(new Error(e.data.message ?? "failed"), { code: e.data.code }));
  };
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.fail(new Error(`The sealing code stopped: ${e.message || "worker error"}`));
    waiting.clear();
    worker = null;
  };
  return worker;
}

export function work<T>(op: string, args: unknown = {}): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { ok, fail });
    get().postMessage({ id, op, args });
  });
}

/** Drop a stuck worker; the next call starts a fresh one. Pending calls fail. */
export function resetWorker() {
  worker?.terminate();
  for (const w of waiting.values()) w.fail(new Error("The sealing code was restarted"));
  waiting.clear();
  worker = null;
}

/** work(), but give up after `ms` and restart the worker so nothing stays stuck. */
export function workWithin<T>(op: string, args: unknown, ms: number): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const t = setTimeout(() => { resetWorker(); fail(Object.assign(new Error("timed out"), { code: "TIMEOUT" })); }, ms);
    work<T>(op, args).then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); });
  });
}
