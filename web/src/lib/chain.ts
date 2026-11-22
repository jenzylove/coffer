// QoreChain calls, made by the worker (src/chain/qore.ts runs there), so the
// page never loads the signing and sealing libraries on the main thread.
import { work } from "./crypto.ts";
import type { Identity } from "../../../src/core/identity.ts";
import type { Reader } from "../../../src/core/vault.ts";
import type { AccountStatus, Grant, GrantRecord, TxResult } from "../../../src/chain/qore.ts";

export const accountStatus = (address: string, mlkem?: Uint8Array) => work<AccountStatus>("accountStatus", { address, mlkem });
export const fetchReader = (address: string) => work<Reader>("fetchReader", { address });
export const fetchPqKeys = (addresses: string[]) => work<Record<string, Uint8Array>>("fetchPqKeys", { addresses });
export const grantHistory = (owner: string, id?: string) => work<GrantRecord[]>("grantHistory", { owner, id });
export const recordGrant = (owner: Identity, grant: Grant) => work<TxResult[]>("recordGrant", { owner, grant });
/** Register the signing key, then the sealing key; onStep gets each step and its transaction. */
export const registerIdentity = (id: Identity, onStep?: (step: string, hash?: string) => void) =>
  work<{ mldsa?: TxResult; kem?: TxResult }>("registerIdentity", { id }, "main", onStep);
