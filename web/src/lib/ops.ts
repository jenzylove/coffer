// The app's chain steps, built only from src/core and src/chain (same as the CLI).
import type { Identity } from "../../../src/core/identity.ts";
import { CofferError, formatCoffer, type CofferFile } from "../../../src/core/vault.ts";
import { work } from "./crypto.ts";
import type { Grant, GrantRecord, TxResult } from "../../../src/chain/qore.ts";
import { accountStatus, fetchPqKeys, grantHistory, recordGrant } from "./chain.ts";
import { api, net, sleep } from "./net.ts";

/** About what one grant record costs (168,960 gas at 0.1 uqor), with headroom. */
export const GRANT_FEE_UQOR = 20_000n;
/** What the two setup transactions need (the CLI's threshold). */
export const SETUP_UQOR = 60_000n;

export interface DripResult { hash: string; uqor: number | string }

/** Ask the relayer for test QOR, then wait until the balance shows it. */
export async function dripAndWait(id: Identity, need: bigint, onNote?: (s: string, hash?: string) => void): Promise<void> {
  const r = await api<DripResult>("/api/drip", { body: { address: id.address } });
  onNote?.("The Coffer relayer sent test QOR to your address", r.hash);
  for (let i = 0; i < 40; i++) {
    const st = await accountStatus(id.address, id.sealKeys.mlkemPublicKey);
    if (st.uqor >= need) return;
    await sleep(2000);
  }
  throw new Error("The relayer's transfer has not arrived after 80 seconds. Check your balance and try again.");
}

/** Make sure there is enough for one more record; ask the relayer once if not. */
export async function ensureFee(id: Identity, onNote?: (s: string, hash?: string) => void): Promise<void> {
  const st = await accountStatus(id.address, id.sealKeys.mlkemPublicKey);
  if (st.uqor >= GRANT_FEE_UQOR) return;
  try {
    await dripAndWait(id, GRANT_FEE_UQOR, onNote);
  } catch (e) {
    throw new Error(`Your address has ${Number(st.uqor) / 1e6} test QOR, not enough for the on chain record (about 0.017). The relayer said: ${(e as Error).message}`);
  }
}

export async function record(id: Identity, g: Grant, onNote?: (s: string, hash?: string) => void): Promise<TxResult[]> {
  await ensureFee(id, onNote);
  // right after a commit the REST node can still report the old account sequence; wait and retry
  for (let i = 0; ; i++) {
    try { return await recordGrant(id, g); }
    catch (e) {
      if (i >= 4 || !/sequence mismatch/i.test((e as Error).message)) throw e;
      await sleep(2500);
    }
  }
}

// local high-water mark, like the CLI's ~/.coffer/seen.json (metadata only, no secrets)
type Seen = Record<string, { epoch: string; version: string }>;
const SEEN = "coffer.seen";
function seen(): Seen {
  try { return JSON.parse(localStorage.getItem(SEEN) ?? "{}"); } catch { return {}; }
}
export function remember(f: CofferFile) {
  const s = seen();
  const old = s[f.id];
  if (old && (BigInt(old.epoch) > f.epoch || (BigInt(old.epoch) === f.epoch && BigInt(old.version) > f.version))) return;
  s[f.id] = { epoch: f.epoch.toString(), version: f.version.toString() };
  try { localStorage.setItem(SEEN, JSON.stringify(s)); } catch { /* storage blocked */ }
}

export interface CheckResult { history: GrantRecord[]; top: bigint }

/** The CLI's checkFile: signatures against chain keys, the chain's latest epoch, this browser's high-water mark. */
export async function checkFile(f: CofferFile): Promise<CheckResult> {
  const keys = await fetchPqKeys([f.owner, f.writer]);
  await work("verify", { text: formatCoffer(f), pqKeys: keys });
  const history = await grantHistory(f.owner, f.id);
  const top = history.reduce((m, g) => (g.epoch > m ? g.epoch : m), 0n);
  if (f.epoch < top) throw new CofferError("ROLLBACK", `this file is epoch ${f.epoch} but its owner announced epoch ${top} on chain: it is an old copy (someone may have restored a version a removed reader can still open)`);
  if (f.epoch > top) throw new CofferError("UNRECORDED", `this file is epoch ${f.epoch} but its owner's latest record on chain is ${top === 0n ? "missing" : `epoch ${top}`}`);
  const s = seen()[f.id];
  if (s && (f.epoch < BigInt(s.epoch) || (f.epoch === BigInt(s.epoch) && f.version < BigInt(s.version)))) {
    throw new CofferError("ROLLBACK", `this browser already saw epoch ${s.epoch} version ${s.version} of this file; this copy is older (epoch ${f.epoch} version ${f.version})`);
  }
  return { history, top };
}

/** Plain words for the error codes a person can hit. */
export function explain(code: string | undefined, message: string): string {
  switch (code) {
    case "NOT_A_READER": return "This address isn't on the list for this file.";
    case "BAD_SIGNATURE": return "Someone changed this file by hand, so it can't be trusted.";
    case "ROLLBACK": return "This is an old copy. A newer version exists.";
    case "UNRECORDED": return "QoreChain has no record of this version, so it wasn't made by Coffer or its owner still needs to record it.";
    case "UNKNOWN_KEY": return "Whoever signed this file hasn't set up Coffer, so it can't be checked.";
    case "WRITER_NOT_READER": return "The last person to change this file isn't on its list.";
    case "BAD_FORMAT": return "This isn't a Coffer file.";
    case "NO_KEM_KEY": return "That address hasn't set up Coffer yet. Ask them to open the Coffer app first.";
    case "BAD_ADDRESS": return "That doesn't look like a QoreChain address. It starts with qor1.";
    case "NOT_OWNER": return "Only the person who sealed this file can change who reads it.";
    case "TX_REFUSED": case "TX_FAILED": return "QoreChain didn't accept the transaction. Try again in a moment.";
    case "TX_TIMEOUT": return "QoreChain is slow to confirm. Try again in a minute.";
    case "REST_ERROR": return "QoreChain can't be reached right now. Try again in a moment.";
    case "NO_FUNDS": return "Your address has no test QOR yet.";
    default: return message;
  }
}
