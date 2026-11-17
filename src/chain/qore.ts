// Everything Coffer reads from or writes to QoreChain. Works in Node and the
// browser (fetch only). Native transactions are hybrid signed (secp256k1 +
// ML-DSA-87) with QoreSign.
import { encodeSecp256k1Pubkey } from "@cosmjs/amino";
import { encodePubkey, makeAuthInfoBytes } from "@cosmjs/proto-signing";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { buildRegisterPqKeyMessage, signHybrid, toHex } from "@qorechain/qoresign";
import { fetchPqKeyStatus, simulateTx, submitWithSignBytesFallback } from "@qorechain/qoresign/network";
import { buildRegisterKemKeyMessage, describeKemRegistryError } from "@qorechain/qoreseal";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import type { Identity } from "../core/identity.ts";
import type { Reader } from "../core/vault.ts";

export interface Network { chainId: string; rest: string; explorerTx?: (hash: string) => string }

export const TESTNET: Network = {
  chainId: "qorechain-diana",
  rest: "https://api-testnet.qore.host",
  explorerTx: (h) => `https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/${h}`,
};

export class ChainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChainError";
    this.code = code;
  }
}

const get = async (net: Network, path: string) => {
  const r = await fetch(`${net.rest}${path}`);
  if (!r.ok) throw new ChainError("REST_ERROR", `QoreChain REST ${r.status} on ${path.split("?")[0]}`);
  return r.json() as Promise<any>;
};

export interface AccountStatus {
  address: string;
  uqor: bigint;
  mldsa: boolean;
  kem: boolean;
  /** The KEM key on chain is this identity's seal key. */
  kemIsOurs: boolean;
}

export async function accountStatus(net: Network, address: string, mlkemPublicKey?: Uint8Array): Promise<AccountStatus> {
  const [bal, pq, kem] = await Promise.all([
    get(net, `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`),
    fetchPqKeyStatus({ rest: net.rest, address }),
    fetchKemKey({ rest: net.rest, address }),
  ]);
  return {
    address,
    uqor: BigInt(bal?.balance?.amount ?? 0),
    mldsa: pq.registered,
    kem: kem.registered,
    kemIsOurs: !!(kem.registered && kem.publicKey && mlkemPublicKey && toHex(kem.publicKey) === toHex(mlkemPublicKey)),
  };
}

/** A reader to seal to, from its address alone: the ML-KEM-1024 key comes from the chain's KEM registry. */
export async function fetchReader(net: Network, address: string): Promise<Reader> {
  if (!/^qor1[02-9ac-hj-np-z]{38,58}$/.test(address)) throw new ChainError("BAD_ADDRESS", `${address} is not a qor1 address`);
  const kem = await fetchKemKey({ rest: net.rest, address });
  if (!kem.registered || !kem.publicKey) {
    throw new ChainError("NO_KEM_KEY", `${address} has not set up Coffer yet: no ML-KEM key on chain. Ask them to run "coffer init".`);
  }
  return { address, mlkemPublicKey: kem.publicKey };
}

/** ML-DSA-87 keys registered on chain, for checking file signatures. */
export async function fetchPqKeys(net: Network, addresses: string[]): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  await Promise.all([...new Set(addresses)].map(async (a) => {
    const s = await fetchPqKeyStatus({ rest: net.rest, address: a });
    if (s.registered && s.publicKey) out[a] = s.publicKey;
  }));
  return out;
}

export interface TxResult { hash: string; height: number; gasUsed: number; feeUqor: number }

/** Sign (hybrid unless the account has no ML-DSA key yet) and send one native transaction; waits until committed. */
export async function sendTx(net: Network, id: Identity, msgs: { typeUrl: string; value: Uint8Array }[], opts: { mode?: "hybrid" | "classicalOnly"; memo?: string } = {}): Promise<TxResult> {
  const mode = opts.mode ?? "hybrid";
  const info = await fetch(`${net.rest}/cosmos/auth/v1beta1/account_info/${id.address}`).then((r) => r.json() as Promise<any>);
  if (!info?.info) throw new ChainError("NO_FUNDS", `${id.address} has never received QOR, so it cannot send transactions yet`);
  const accountNumber = BigInt(info.info.account_number);
  const sequence = BigInt(info.info.sequence ?? "0");
  const bodyBytes = TxBody.encode(TxBody.fromPartial({ messages: msgs, memo: opts.memo ?? "" })).finish();
  const sign = (gas: bigint) => signHybrid({
    chainId: net.chainId, accountNumber, bodyBytes, mode,
    authInfoBytes: makeAuthInfoBytes(
      [{ pubkey: encodePubkey(encodeSecp256k1Pubkey(id.classicalKey.publicKey)), sequence }],
      [{ denom: "uqor", amount: ((gas + 9n) / 10n).toString() }], // 0.1 uqor per gas
      Number(gas), undefined, undefined, SignMode.SIGN_MODE_DIRECT,
    ),
    classicalKey: id.classicalKey,
    pqKey: mode === "classicalOnly" ? undefined : id.pqKey,
  }).txBytes;
  const sim = await simulateTx({ rest: net.rest, txBytes: sign(600_000n) });
  const gas = sim.suggestedGasLimit;
  const res = await submitWithSignBytesFallback({ rest: net.rest, chainId: net.chainId, sign: () => sign(gas) });
  if (res.code !== 0) throw new ChainError("TX_REFUSED", `refused: ${describeKemRegistryError(res.codespace, res.code) ?? res.log}`);
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${net.rest}/cosmos/tx/v1beta1/txs/${res.txhash}`);
    if (r.ok) {
      const b = (await r.json()) as any;
      const tr = b.tx_response;
      if (tr.code !== 0) throw new ChainError("TX_FAILED", `transaction ${res.txhash} failed: ${tr.raw_log}`);
      return { hash: res.txhash, height: Number(tr.height), gasUsed: Number(tr.gas_used), feeUqor: Number(b.tx.auth_info.fee.amount?.[0]?.amount ?? 0) };
    }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  throw new ChainError("TX_TIMEOUT", `transaction ${res.txhash} was not committed in 90 seconds`);
}

/**
 * Make an address sealable: register its ML-DSA-87 key (classical-signed, with
 * proof of possession), then its ML-KEM-1024 key (hybrid-signed). Skips what is
 * already done. Needs about 0.06 QOR the first time.
 */
export async function registerIdentity(net: Network, id: Identity, onStep?: (s: string, tx?: TxResult) => void): Promise<{ mldsa?: TxResult; kem?: TxResult }> {
  const out: { mldsa?: TxResult; kem?: TxResult } = {};
  const st = await accountStatus(net, id.address, id.sealKeys.mlkemPublicKey);
  if (!st.mldsa) {
    onStep?.("registering ML-DSA-87 signing key");
    const msg = buildRegisterPqKeyMessage({ chainId: net.chainId, account: id.address, pqKey: id.pqKey, classicalPublicKey: id.classicalKey.publicKey });
    out.mldsa = await sendTx(net, id, [msg as { typeUrl: string; value: Uint8Array }], { mode: "classicalOnly" });
    onStep?.("ML-DSA-87 key registered", out.mldsa);
    // let the next block see the registered key before a hybrid-signed tx
    for (let i = 0; i < 20 && !(await fetchPqKeyStatus({ rest: net.rest, address: id.address })).registered; i++) await new Promise((ok) => setTimeout(ok, 1500));
  }
  if (!st.kemIsOurs) {
    onStep?.("publishing ML-KEM-1024 key");
    out.kem = await sendTx(net, id, [buildRegisterKemKeyMessage({ sender: id.address, mlkemPublicKey: id.sealKeys.mlkemPublicKey }) as { typeUrl: string; value: Uint8Array }]);
    onStep?.("ML-KEM-1024 key published", out.kem);
  }
  return out;
}

// ---- grant records ---------------------------------------------------------
// Every share and revoke is a hybrid-signed 1 uqor self-send whose memo says
// what changed. Anyone can list them; the owner's signature is the chain's.

export const MEMO_PREFIX = "coffer/1";
const MAX_MEMO = 256;

export type GrantOp = "create" | "share" | "revoke";
export interface Grant { op: GrantOp; fileId: string; epoch: bigint; version: bigint; added: string[]; removed: string[] }
export interface GrantRecord extends Grant { hash: string; height: number; time: string; owner: string }


export function grantMemos(g: Grant): string[] {
  const head = `${MEMO_PREFIX} ${g.op} ${g.fileId} e${g.epoch} v${g.version}`;
  const parts = [...g.added.map((a) => `+${a}`), ...g.removed.map((a) => `-${a}`)];
  const memos: string[] = [];
  let cur = head;
  for (const p of parts) {
    if (cur.length + 1 + p.length > MAX_MEMO) { memos.push(cur); cur = head; }
    cur += ` ${p}`;
  }
  memos.push(cur);
  return memos;
}

export function parseGrantMemo(memo: string): Grant | null {
  const m = memo.match(/^coffer\/1 (create|share|revoke) ([0-9a-f]{12}) e(\d+) v(\d+)((?: [+-]qor1[0-9a-z]+)*)$/);
  if (!m) return null;
  const parts = (m[5] ?? "").trim().split(" ").filter(Boolean);
  return {
    op: m[1] as GrantOp, fileId: m[2]!, epoch: BigInt(m[3]!), version: BigInt(m[4]!),
    added: parts.filter((p) => p.startsWith("+")).map((p) => p.slice(1)),
    removed: parts.filter((p) => p.startsWith("-")).map((p) => p.slice(1)),
  };
}

export async function recordGrant(net: Network, owner: Identity, g: Grant): Promise<TxResult[]> {
  const out: TxResult[] = [];
  for (const memo of grantMemos(g)) {
    const send = MsgSend.encode(MsgSend.fromPartial({ fromAddress: owner.address, toAddress: owner.address, amount: [{ denom: "uqor", amount: "1" }] })).finish();
    out.push(await sendTx(net, owner, [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: send }], { memo }));
  }
  return out;
}

/** Grant records the owner put on chain, newest first, optionally for one file. */
export async function grantHistory(net: Network, owner: string, id?: string, limit = 100): Promise<GrantRecord[]> {
  const q = encodeURIComponent(`message.sender='${owner}'`);
  const b = await get(net, `/cosmos/tx/v1beta1/txs?query=${q}&order_by=ORDER_BY_DESC&limit=${limit}`);
  const out: GrantRecord[] = [];
  for (const t of b.tx_responses ?? []) {
    // only self-sends signed by the owner count; the memo of anything else is ignored
    const msgs = t.tx?.body?.messages ?? [];
    if (msgs.length !== 1 || msgs[0]["@type"] !== "/cosmos.bank.v1beta1.MsgSend" || msgs[0].from_address !== owner || msgs[0].to_address !== owner || t.code !== 0) continue;
    const g = parseGrantMemo(t.tx.body.memo ?? "");
    if (!g || (id && g.fileId !== id)) continue;
    out.push({ ...g, hash: t.txhash, height: Number(t.height), time: t.timestamp, owner });
  }
  return out;
}

/** The highest epoch the owner has announced on chain for a file (0 if none). A file below it is a rollback. */
export async function latestEpoch(net: Network, owner: string, id: string): Promise<bigint> {
  const h = await grantHistory(net, owner, id);
  return h.reduce((m, g) => (g.epoch > m ? g.epoch : m), 0n);
}
