// The poster: a separate unified account (secp256k1 EVM key + ML-DSA-87) that
// submits signed cards and heads to the Coffer contract and pays the gas.
// It cannot forge anything: the contract checks the account's or the owner's
// ML-DSA-87 signature. It holds no other key, and its EVM window is scoped to
// the Coffer contract only (deploys use a short separate window).
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner, buildRegisterPqcKeyMsg, closeEvmWindowMsg, deriveUnifiedAccount, fetchPqcStatus, signProofOfPossession, type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowStatus, openEvmWindowMessage } from "@qorechain/evm";
import { COFFER_ABI, refusalText } from "../src/chain/coffer.ts";

export const POSTER_NET = {
  chainId: "qorechain-diana",
  rest: process.env.COFFER_REST ?? "https://api-testnet.qore.host",
  rpc: process.env.COFFER_RPC ?? "https://rpc-testnet.qore.host",
  evm: process.env.COFFER_EVM ?? "https://evm-testnet.qore.host",
};
export const evmChain = defineChain({ id: 9800, name: "qorechain-diana", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [POSTER_NET.evm] } } });
export const FEES = { maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

export class PosterError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export class Poster {
  readonly acc: UnifiedAccount;
  readonly contract: Hex | undefined;
  readonly pub = createPublicClient({ chain: evmChain, transport: http() });
  private queue: Promise<unknown> = Promise.resolve();
  private log: (s: string) => void;
  private constructor(acc: UnifiedAccount, contract?: Hex, log: (s: string) => void = console.log) {
    this.acc = acc;
    this.contract = contract;
    this.log = log;
  }

  static async from(mnemonic: string, contract?: Hex, log?: (s: string) => void) {
    return new Poster(await deriveUnifiedAccount(mnemonic, 0), contract, log);
  }

  get address() { return this.acc.cosmos; }
  get evm() { return this.acc.evm as Hex; }

  /** One queue for every poster transaction: one nonce stream, no races. */
  serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.queue.then(f, f);
    this.queue = p.catch(() => undefined);
    return p as Promise<T>;
  }

  private async seq() {
    const r = await fetch(`${POSTER_NET.rest}/cosmos/auth/v1beta1/accounts/${this.acc.cosmos}`);
    if (r.status === 404) throw new PosterError(`the poster ${this.acc.cosmos} has no QOR yet`, 503);
    const b = (await r.json()) as any;
    const a = b.account?.base_account ?? b.account ?? {};
    return { accountNumber: BigInt(a.account_number ?? "0"), sequence: BigInt(a.sequence ?? "0") };
  }

  /** A native-lane transaction from the poster, waited for. */
  async native(mode: "hybrid" | "classical", messages: any[], label: string, gas = "400000") {
    const { accountNumber, sequence } = await this.seq();
    const signer = new EthNativeSigner(this.acc, { signMode: mode, rest: POSTER_NET.rest });
    const t = await StargateClient.connect(POSTER_NET.rpc);
    let hash: string;
    try {
      const fee = { amount: [{ denom: "uqor", amount: String(Math.ceil(Number(gas) / 8)) }], gas };
      const res = await signer.signAndBroadcast(t, { chainId: POSTER_NET.chainId, accountNumber, sequence, fee, messages });
      hash = res.transactionHash as string;
    } finally { t.disconnect(); }
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`${POSTER_NET.rest}/cosmos/tx/v1beta1/txs/${hash}`);
      if (r.ok) {
        const b = (await r.json()) as any;
        const code = b.tx_response?.code ?? 0;
        this.log(`${label}: ${hash} code ${code}`);
        if (code) throw new PosterError(`${label} failed: ${b.tx_response?.raw_log}`, 502);
        return hash;
      }
      await sleep(1500);
    }
    throw new PosterError(`${label}: ${hash} not committed`, 504);
  }

  /** Register the poster's ML-DSA-87 key (with proof of possession) once. */
  async ensureRegistered() {
    const st = await fetchPqcStatus({ rest: POSTER_NET.rest, address: this.acc.cosmos });
    if (st.registered) return;
    const proofOfPossession = signProofOfPossession({ chainId: POSTER_NET.chainId, account: this.acc.cosmos, keypair: this.acc.pqc });
    await this.native("classical", [buildRegisterPqcKeyMsg(this.acc.cosmos, { pqcKeypair: this.acc.pqc, proofOfPossession })], "poster ML-DSA-87 key");
  }

  /** Keep a window open that admits calls to the Coffer contract only. */
  async ensureWindow(opts: { targets?: Hex[]; minTxs?: number; blocks?: bigint; maxTxs?: bigint; maxValueUqor?: bigint } = {}) {
    const w = await evmWindowStatus({ rest: POSTER_NET.rest, address: this.acc.cosmos });
    const targets = opts.targets ?? (this.contract ? [this.contract] : []);
    if (w.found && w.live && w.remainingTxs > BigInt(opts.minTxs ?? 3) && w.remainingBlocks > 60n && w.maxValue - w.usedValue > 500_000n) return;
    const msg = openEvmWindowMessage({
      sender: this.acc.cosmos,
      blocks: opts.blocks ?? 17_000n,
      maxTxs: opts.maxTxs ?? 400n,
      maxValue: opts.maxValueUqor ?? 400n * 400_000n,
      ...(targets.length ? { allowedTargets: targets } : {}),
    });
    await this.native("hybrid", [msg], `poster window (${targets.length ? "Coffer contract only" : "deploy"})`);
    await sleep(3000);
  }

  /** Call the contract. Simulates first, so a refusal costs nothing and comes back in plain words. */
  /** Close any open window and open one scoped to this poster's contract (after the contract changed). */
  async resetWindow() {
    const w = await evmWindowStatus({ rest: POSTER_NET.rest, address: this.acc.cosmos });
    if (w.found && w.live) await this.native("hybrid", [closeEvmWindowMsg(this.acc.cosmos)], "close the poster's old window");
    await this.ensureWindow();
  }

  async call(functionName: CofferCall, args: readonly unknown[]) {
    if (!this.contract) throw new PosterError("the Coffer contract is not deployed yet", 503);
    return this.serial(async () => {
      let gas: bigint;
      try {
        gas = await this.pub.estimateGas({ account: this.evm, to: this.contract!, data: encode(functionName, args) });
      } catch (e: any) {
        const data = (e?.cause?.data ?? e?.data ?? e?.cause?.cause?.data) as Hex | undefined;
        throw new PosterError(refusalText(data) ?? `QoreChain refused it: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 200)}`, 400);
      }
      await this.ensureWindow();
      const wallet = createWalletClient({ account: privateKeyToAccount(this.acc.privateKey as Hex), chain: evmChain, transport: http() });
      const hash = await wallet.sendTransaction({ to: this.contract!, data: encode(functionName, args), gas: (gas * 13n) / 10n, ...FEES });
      const rc = await this.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (rc.status !== "success") throw new PosterError(`${functionName} reverted on chain: ${hash}`, 502);
      this.log(`${functionName}: ${hash} block ${rc.blockNumber} gas ${rc.gasUsed}`);
      return { hash, block: Number(rc.blockNumber), gas: Number(rc.gasUsed) };
    });
  }
}

type CofferCall = "setCard" | "setHead" | "write" | "open" | "setDevice";
const encode = (functionName: CofferCall, args: readonly unknown[]) =>
  encodeFunctionData({ abi: COFFER_ABI, functionName, args } as never);
