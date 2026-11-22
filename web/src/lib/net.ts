// Network config and small helpers shared by every page.
import type { Network } from "../../../src/chain/qore.ts";

export const CHAIN = "qorechain-diana";

/** QoreChain REST goes through our own server (/rest), because the REST API sends no CORS headers. */
export const net: Network = { chainId: CHAIN, rest: "/rest" };

const REST = "https://api-testnet.qore.host";

/** The explorer page for a transaction (switch it to Testnet there). */
export const explorerTx = (hash: string) => `https://dashboard.qorechain.io/explorer/tx/${hash}`;

/** The raw record, readable in any browser tab: EVM hashes (0x…) through the ethereum_tx index, native ones directly. */
export const restTx = (hash: string) => hash.startsWith("0x")
  ? `${REST}/cosmos/tx/v1beta1/txs?query=ethereum_tx.ethereumTxHash%3D%27${hash}%27`
  : `${REST}/cosmos/tx/v1beta1/txs/${hash}`;

/** Native transactions (setup) open as raw REST; contract records open in the explorer. */
export const txUrl = (hash: string) => (hash.startsWith("0x") ? explorerTx(hash) : restTx(hash));

export const short = (a: string, head = 10, tail = 6) => (a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a);

export const isQorAddress = (a: string) => /^qor1[02-9ac-hj-np-z]{38,58}$/.test(a);

export const qor = (uqor: bigint | number) => {
  const n = Number(uqor) / 1e6;
  return n.toLocaleString("en", { maximumFractionDigits: 4 });
};

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function errCode(e: unknown): string | undefined {
  return (e as { code?: string })?.code;
}

/** "the relayer is out" -> "The relayer is out." (server errors are plain sentences in lower case). */
export const sentence = (s: string) => {
  const t = s.trim();
  if (!t) return t;
  const up = /^(qor1|0x)/.test(t) ? t : t[0]!.toUpperCase() + t.slice(1); // never capitalize an address
  return up.replace(/([^.!?])$/, "$1.");
};

/** An Error that carries a code the screens explain in plain words. */
export const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Calls our server. Throws an Error carrying the server's own error text, or a plain note when the server is unreachable. */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method: init?.method ?? (init?.body ? "POST" : "GET"),
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw coded("SERVER_DOWN", "The Coffer server is not reachable right now. Try again in a moment.");
  }
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    if (body?.error) throw Object.assign(new Error(sentence(String(body.error))), { status: r.status });
    if (r.status >= 500) throw coded("SERVER_DOWN", "The Coffer server is not reachable right now. Try again in a moment.");
    if (r.status === 404) throw coded("SERVER_OLD", "This part of the Coffer server is not running yet.");
    throw new Error(`The server refused the request (status ${r.status}).`);
  }
  if (body === null) throw new Error("The server sent an empty answer.");
  return body as T;
}

export function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Base64url without padding, for small values kept in localStorage (seeds). */
export function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(t: string): Uint8Array {
  const s = t.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
}
