// Calls into the crypto worker. Errors keep their code (NOT_A_READER, ...).
// One worker per lane: the landing hero runs in its own lane so it never waits
// in line behind heavier work (the try it demo, the app).
//
// Sign bridge: the worker cannot reach window.qorex, so when a wallet account
// signs, the worker posts { id, sign: { req, chainId, address, dataB64 } } here;
// we ask the registered wallet and post back { signReply: { req, sig } } or
// { signReply: { req, error, code } }. A closed popup becomes SIGN_REJECTED,
// and the operation fails cleanly with nothing changed.
import type { MessageSignature } from "@qorechain/qoresign";

type Lane = "main" | "hero";
const workers = new Map<Lane, Worker>();
let seq = 0;
const waiting = new Map<number, { lane: Lane; ok: (v: any) => void; fail: (e: Error) => void; progress?: (text: string, hash?: string) => void }>();

/** The connected wallet: QoreX's signArbitrary for one address. */
export interface WalletSigner { address: string; sign: (chainId: string, address: string, text: string) => Promise<MessageSignature> }
let wallet: WalletSigner | null = null;
export function setWallet(w: WalletSigner | null) { wallet = w; }

// how many wallet approvals are open right now, for "Approve it in QoreX"
let asking = 0;
const askListeners = new Set<(n: number) => void>();
function setAsking(d: number) { asking += d; for (const l of askListeners) l(asking); }
/** Called whenever a wallet approval opens or closes. Returns an unsubscribe. */
export function onWalletAsk(fn: (open: number) => void): () => void {
  askListeners.add(fn);
  return () => { askListeners.delete(fn); };
}

const SIGN_WAIT_MS = 180_000;

/** Keep the QoreSign fields only; a wallet may add its own. */
function cleanSig(s: MessageSignature): MessageSignature {
  return {
    signatureType: s.signatureType,
    classical: { keyType: s.classical.keyType, publicKey: s.classical.publicKey, signature: s.classical.signature },
    ...(s.pq ? { pq: { algorithmId: s.pq.algorithmId, signature: s.pq.signature } } : {}),
  };
}

function walletFailure(e: unknown): { error: string; code: string } {
  const x = e as { message?: string; code?: unknown };
  const msg = String(x?.message ?? e ?? "");
  if (x?.code === "SIGN_TIMEOUT") return { error: msg, code: "SIGN_TIMEOUT" };
  if (x?.code === 4001 || /reject|denied|cancel|closed|declin|abort|dismiss/i.test(msg)) return { error: "You closed QoreX without signing. Nothing changed.", code: "SIGN_REJECTED" };
  return { error: msg || "QoreX could not sign.", code: "WALLET_ERROR" };
}

async function answerSign(worker: Worker, s: { req: number; chainId: string; address: string; dataB64: string }) {
  const reply = (r: { sig: MessageSignature } | { error: string; code: string }) => worker.postMessage({ signReply: { req: s.req, ...r } });
  if (!wallet || wallet.address !== s.address) {
    reply({ error: "QoreX isn't connected to this address right now. Connect it and try again.", code: "WALLET_GONE" });
    return;
  }
  const text = new TextDecoder().decode(Uint8Array.from(atob(s.dataB64), (c) => c.charCodeAt(0)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  setAsking(1);
  try {
    const sig = await Promise.race([
      wallet.sign(s.chainId, s.address, text),
      new Promise<never>((_, no) => { timer = setTimeout(() => no(Object.assign(new Error("QoreX did not answer in 3 minutes. Nothing changed."), { code: "SIGN_TIMEOUT" })), SIGN_WAIT_MS); }),
    ]);
    if (!sig || typeof sig !== "object" || !sig.classical) throw new Error("QoreX sent back an empty signature.");
    reply({ sig: cleanSig(sig) });
  } catch (e) {
    reply(walletFailure(e));
  } finally {
    clearTimeout(timer);
    setAsking(-1);
  }
}

function failLane(lane: Lane, message: string) {
  for (const [id, w] of waiting) if (w.lane === lane) { w.fail(new Error(message)); waiting.delete(id); }
}

type FromWorker = {
  id: number; ok?: boolean; value?: unknown; message?: string; code?: string;
  progress?: { text: string; hash?: string };
  sign?: { req: number; chainId: string; address: string; dataB64: string };
};

function get(lane: Lane): Worker {
  const have = workers.get(lane);
  if (have) return have;
  // the hero has its own small worker (sealing only); the app's worker also carries the chain code
  const worker = lane === "hero"
    ? new Worker(new URL("./hero.worker.ts", import.meta.url), { type: "module" })
    : new Worker(new URL("./crypto.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    if (e.data.sign) { void answerSign(worker, e.data.sign); return; }
    const w = waiting.get(e.data.id);
    if (!w) return;
    if (e.data.progress) { w.progress?.(e.data.progress.text, e.data.progress.hash); return; }
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

export function work<T>(op: string, args: unknown = {}, lane: Lane = op.startsWith("hero") ? "hero" : "main", progress?: (text: string, hash?: string) => void): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { lane, ok, fail, progress });
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
