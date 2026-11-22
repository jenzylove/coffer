// Opening a file as a reader: a signed request that QoreChain answers. The
// owner opens with its own copy of the release piece (no request). A QoreX
// user signs requests with a device key this browser keeps, approved by the
// wallet for about a day (one signature); a browser key signs with itself.
import type { SealKeyPair } from "@qorechain/qoreseal";
import type { DotenvEntry } from "../../../src/core/dotenv.ts";
import { work } from "./crypto.ts";
import { b64url, coded, fromB64url } from "./net.ts";
import type { Kind, OwnerRef } from "./identity.tsx";

const deviceKey = (a: string) => `coffer.device.${a}`;

/** This browser's device key seed for the wallet (32 bytes), made on first use. */
export function deviceSeed(address: string): Uint8Array {
  try {
    const have = localStorage.getItem(deviceKey(address));
    if (have) return fromB64url(have);
  } catch { /* storage blocked: a fresh key each time */ }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  try { localStorage.setItem(deviceKey(address), b64url(seed)); } catch { /* storage blocked */ }
  return seed;
}

export interface Opened { entries: DotenvEntry[]; hash: string | null; block: number | null }
interface Who { address: string; keys: SealKeyPair; kind: Kind | null; owner: OwnerRef | null }

/**
 * Open `text` as this account. Throws NEEDS_DEVICE when a QoreX user's browser
 * has no live approval (call approveThisBrowser, then try again), and
 * REFUSED_BY_CHAIN when the contract refuses the request.
 */
export async function openAsReader(who: Who, text: string, checks = true): Promise<Opened> {
  if (!who.owner) throw coded("WALLET_GONE", "not connected");
  if (who.kind === "qorex") {
    const seed = deviceSeed(who.address);
    const st = await work<{ live: boolean }>("deviceStatus", { address: who.address, seed });
    if (!st.live) throw coded("NEEDS_DEVICE", "this browser is not approved for this wallet right now");
    return work<Opened>("readerOpen", { text, reader: who.address, keys: who.keys, by: { kind: "device", seed }, checks });
  }
  return work<Opened>("readerOpen", { text, reader: who.address, keys: who.keys, by: { kind: "account", owner: who.owner }, checks });
}

/** One QoreX signature: this browser may sign open requests for about a day. */
export async function approveThisBrowser(who: { address: string; owner: OwnerRef }): Promise<{ hash: string | null }> {
  return work<{ hash: string | null }>("approveDevice", { address: who.address, seed: deviceSeed(who.address), owner: who.owner });
}

// sealed copies a reader opened, kept so a removed reader can see that even its own copy no longer opens
const copiesKey = (a: string) => `coffer.copies.${a}`;
export function keptCopy(address: string, fileId: string): string | null {
  try { return (JSON.parse(localStorage.getItem(copiesKey(address)) ?? "{}") as Record<string, string>)[fileId] ?? null; } catch { return null; }
}
export function keepCopy(address: string, fileId: string, text: string) {
  try {
    const all = JSON.parse(localStorage.getItem(copiesKey(address)) ?? "{}") as Record<string, string>;
    all[fileId] = text;
    localStorage.setItem(copiesKey(address), JSON.stringify(all));
  } catch { /* storage blocked */ }
}
