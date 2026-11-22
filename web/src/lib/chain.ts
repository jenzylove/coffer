// QoreChain calls, made by the worker (src/chain runs there), so the page never
// loads the signing and sealing libraries on the main thread.
import { work } from "./crypto.ts";
import type { SealKeyPair } from "@qorechain/qoreseal";
import type { Identity } from "../../../src/core/identity.ts";
import type { ChainHead } from "../../../src/core/vault.ts";
import type { TxResult } from "../../../src/chain/qore.ts";

export type CardState = { state: "none" } | { state: "ours" | "other"; height: number } | { state: "error"; code?: string; message: string };
export interface Status { uqor: bigint; pq: boolean; kemIsOurs: boolean; card: CardState }

export const status = (address: string, keys: SealKeyPair | null) => work<Status>("status", { address, keys });
export const hasCard = (address: string) => work<boolean>("hasCard", { address });
export const readHead = (fileId: string) => work<ChainHead | null>("readHead", { fileId });
export const changedReaders = (text: string) => work<string[]>("changedReaders", { text });
/** Register the signing key, then the sealing key; onStep gets each step and its transaction. */
export const registerIdentity = (id: Identity, onStep?: (step: string, hash?: string) => void) =>
  work<{ mldsa?: TxResult; kem?: TxResult }>("registerIdentity", { id }, "main", onStep);
