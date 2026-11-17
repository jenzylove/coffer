// Network config and small helpers shared by every page.
import type { Network } from "../../../src/chain/qore.ts";

/** QoreChain REST goes through our own server (/rest), because the REST API sends no CORS headers. */
export const net: Network = { chainId: "qorechain-diana", rest: "/rest" };

/** Public tx link (the real REST endpoint, readable in any browser tab). */
export const txUrl = (hash: string) => `https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/${hash}`;

export const short = (a: string, head = 10, tail = 6) => (a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a);

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
    throw new Error("The Coffer server is not reachable right now. Try again in a moment.");
  }
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    if (body?.error) throw new Error(body.error);
    if (r.status >= 500) throw new Error("The Coffer server is not reachable right now. Try again in a moment.");
    if (r.status === 404) throw new Error("This part of the Coffer server is not running yet.");
    throw new Error(`The server refused the request (status ${r.status}).`);
  }
  if (body === null) throw new Error("The server sent an empty answer.");
  return body as T;
}

export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
