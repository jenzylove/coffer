// The app's chain steps, built only from src/core and src/chain (same as the CLI).
// The Coffer server submits signed cards and changes to the Coffer contract and
// pays the gas; it cannot forge either, because the contract checks the signature.
import type { SealKeyPair } from "@qorechain/qoreseal";
import type { RecipientCard } from "../../../src/core/card.ts";
import { work } from "./crypto.ts";
import { status } from "./chain.ts";
import { api, coded, sentence, sleep } from "./net.ts";
import type { OwnerRef } from "./identity.tsx";

/** What the two setup transactions of a browser key need (the CLI's threshold). */
export const SETUP_UQOR = 60_000n;

export interface DripResult { hash: string; uqor: number | string }
export interface Recorded { hash: string; block: number }

/** Ask the relayer for test QOR, then wait until the balance shows it. */
export async function dripAndWait(address: string, need: bigint, onNote?: (s: string, hash?: string) => void): Promise<void> {
  const r = await api<DripResult>("/api/drip", { body: { address } });
  onNote?.("The Coffer relayer sent test QOR to this key", r.hash);
  for (let i = 0; i < 40; i++) {
    const st = await status(address, null).catch(() => null);
    if (st && st.uqor >= need) return;
    await sleep(2000);
  }
  throw new Error("The relayer's transfer has not arrived after 80 seconds. Try again in a moment.");
}


/** Record the owner's signed change on QoreChain. Called before the new version is kept, so no unrecorded copy exists. */
export async function recordHead(text: string): Promise<Recorded> {
  try {
    return await api<Recorded>("/api/head", { body: { file: text } });
  } catch (e) {
    throw coded("NOT_RECORDED", sentence((e as Error).message));
  }
}

/** Sign this account's card (one wallet approval) and have the server put it in the Coffer contract. */
export async function publishCard(owner: OwnerRef, keys: SealKeyPair, onStep: (s: string, hash?: string) => void): Promise<Recorded> {
  onStep(owner.kind === "wallet" ? "Approve the card in QoreX" : "Signing your card");
  const signed = await work<{ card: RecipientCard; mlkemKey: string }>("signCard", { owner, keys });
  onStep("Putting your card on QoreChain");
  let r: Recorded;
  try {
    r = await api<Recorded>("/api/card", { body: signed });
  } catch (e) {
    throw coded("CARD_REFUSED", sentence((e as Error).message));
  }
  onStep("Card recorded on QoreChain", r.hash);
  return r;
}

// ---- files kept in this browser (sealed text only: safe to store) ------------

export interface LogEntry { what: string; hash: string; block?: number; at: string }
export interface Stored {
  text: string;
  /** The version before the last removal, for "Send Ada the old copy". */
  old?: string;
  tx?: string;
  block?: number;
  changed: string;
  note?: string;
  removed?: string[];
  /** Addresses we invited that have not signed a card yet. */
  waiting?: string[];
  /** Changes recorded from this browser. */
  log?: LogEntry[];
  /** After the last removal: who, and the names to change at the provider. */
  rotate?: { who: string; names: string[] };
}
// v3: files whose every open is a request to QoreChain (format 3); older copies are not listed
const FILES = "coffer.files.v3";
export function loadFiles(): Stored[] {
  try { return (JSON.parse(localStorage.getItem(FILES) ?? "null") as Stored[] | null) ?? []; } catch { return []; }
}
export function saveFiles(list: Stored[]) { try { localStorage.setItem(FILES, JSON.stringify(list)); } catch { /* storage blocked */ } }

/** Plain words for the error codes a person can hit. */
export function explain(code: string | undefined, message: string): string {
  switch (code) {
    case "SIGN_REJECTED": return "You closed QoreX without signing. Nothing changed.";
    case "REFUSED_BY_CHAIN": return "QoreChain refused: you're not on this file's list any more.";
    case "NEEDS_DEVICE": return "Approve this browser for a day first (one signature in QoreX).";
    case "DEVICE_REFUSED": return `QoreChain didn't approve this browser. ${sentence(message)}`;
    case "NOT_OPENED": return `QoreChain didn't release the file. ${sentence(message)}`;
    case "NO_KEEPER": return "Opening through QoreChain isn't set up on this server yet.";
    case "BAD_RELEASE": return "The piece QoreChain released doesn't open this copy.";
    case "SIGN_TIMEOUT": return "QoreX didn't answer, so nothing changed. Try again.";
    case "WALLET_GONE": return "QoreX isn't connected right now. Connect it and try again.";
    case "WALLET_ERROR": return `QoreX couldn't sign: ${message}`;
    case "NOT_RECORDED": return `QoreChain didn't record it, so nothing changed. ${message}`;
    case "CARD_REFUSED":
      if (/no proven ML-DSA-87 key/i.test(message)) return "QoreChain didn't take the card: this wallet's quantum safe key was registered without a proof, so the contract can't trust it yet.";
      if (/no ML-DSA-87 key/i.test(message)) return "QoreChain didn't take the card: this wallet has no quantum safe key on chain yet. Send any amount once from QoreX, then try again.";
      return `QoreChain didn't take the card. ${message}`;
    case "NO_CONTRACT": return "Recording on QoreChain isn't set up on this server yet.";
    case "NO_CARD": return "This address hasn't opened Coffer yet.";
    case "CARD_INVALID": return "The card on QoreChain for this address doesn't check out, so Coffer won't seal to it.";
    case "NOT_A_READER": return "This address isn't on the list for this file.";
    case "BAD_SIGNATURE": return "Someone changed this file by hand, so it can't be trusted.";
    case "STALE": return "This is an old copy. QoreChain has a newer one, so someone removed since then might still be in it.";
    case "UNRECORDED": return "QoreChain has no record of this version, so Coffer can't tell if it's the latest copy.";
    case "OWNER_MISMATCH": return "QoreChain says this file belongs to someone else.";
    case "FORKED": return "QoreChain has a different reader list for this version, so it won't be opened.";
    case "OLD_FORMAT": return "This file uses Coffer's first format. Ask its owner to seal it again.";
    case "UNKNOWN_KEY": return "Whoever signed this file has no signing key on QoreChain, so it can't be checked.";
    case "WRITER_NOT_READER": return "The last person to change this file isn't on its list.";
    case "WRONG_CHAIN": return "This file is for another QoreChain network.";
    case "BAD_FORMAT": return "This isn't a Coffer file.";
    case "BAD_NAME": return "A file name must be 1 to 64 characters on one line.";
    case "TOO_MANY_READERS": return "A sealed file holds about 10 people. Nothing was signed or changed. Split the team across two files.";
    case "BAD_ADDRESS": return "That doesn't look like a QoreChain address. It starts with qor1.";
    case "NOT_OWNER": return "Only the person who sealed this file can change who opens it.";
    case "EVM_ERROR": case "REST_ERROR": return "QoreChain can't be reached right now. Try again in a moment.";
    case "TX_REFUSED": case "TX_FAILED": return "QoreChain didn't accept the transaction. Try again in a moment.";
    case "TX_TIMEOUT": return "QoreChain is slow to confirm. Try again in a minute.";
    case "NO_FUNDS": return "This key has no test QOR yet.";
    default: return message;
  }
}
