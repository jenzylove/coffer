// Deploys Coffer.sol to the QoreChain testnet from the poster account, then
// leaves the poster with a window scoped to the new contract only.
// Run from the repo root after `cd contracts && forge build`:
//   COFFER_ENV=~/coffer-launch/relayer/.env node contracts/script/deploy.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { closeEvmWindowMsg } from "@qorechain/sdk";
import { Poster, POSTER_NET, FEES, evmChain } from "../../server/poster.ts";
import { SITE } from "../../src/core/vault.ts";

const envPath = process.env.COFFER_ENV ?? `${process.env.HOME}/coffer-launch/relayer/.env`;
const mnemonic = (process.env.POSTER_MNEMONIC ?? readFileSync(envPath, "utf8").match(/^POSTER_MNEMONIC=(.*)$/m)?.[1] ?? "").trim();
if (!mnemonic) throw new Error("POSTER_MNEMONIC missing");
const OUT = "deployments/testnet.json";
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};

const poster = await Poster.from(mnemonic);
const bal = await (await fetch(`${POSTER_NET.rest}/cosmos/bank/v1beta1/balances/${poster.address}/by_denom?denom=uqor`)).json() as any;
const uqor = BigInt(bal?.balance?.amount ?? 0);
console.log(`poster ${poster.address} (${poster.evm}) has ${Number(uqor) / 1e6} QOR`);
if (uqor < 1_000_000n) { console.log("fund the poster first (at least 1 QOR)"); process.exit(1); }

await poster.ensureRegistered();
const art = JSON.parse(readFileSync("contracts/out/Coffer.sol/Coffer.json", "utf8"));
// A deploy needs a window without targets (contract creation is refused in a scoped one), so close
// any scoped window first, then open a short one: 2 txs.
const { evmWindowStatus } = await import("@qorechain/evm");
const w = await evmWindowStatus({ rest: POSTER_NET.rest, address: poster.address });
if (w.found && w.live) await poster.native("hybrid", [closeEvmWindowMsg(poster.address)], "close the open window");
await poster.ensureWindow({ targets: [], minTxs: 0, blocks: 300n, maxTxs: 2n, maxValueUqor: 2n * 900_000n });
const wallet = createWalletClient({ account: privateKeyToAccount(poster.acc.privateKey as Hex), chain: evmChain, transport: http() });
const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object as Hex, args: [POSTER_NET.chainId, SITE], gas: 6_000_000n, ...FEES });
const rc = await poster.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy failed: ${hash}`);
console.log(`Coffer deployed at ${rc.contractAddress} (tx ${hash}, block ${rc.blockNumber}, gas ${rc.gasUsed})`);

// Close the open window and open one that reaches the Coffer contract only.
await poster.native("hybrid", [closeEvmWindowMsg(poster.address)], "close deploy window");
const scoped = await Poster.from(mnemonic, rc.contractAddress);
await scoped.ensureWindow();

writeFileSync(OUT, JSON.stringify({
  ...prev,
  network: POSTER_NET.chainId,
  coffer: rc.contractAddress,
  cofferDeployTx: hash,
  cofferDeployBlock: Number(rc.blockNumber),
  poster: poster.address,
  posterEvm: poster.evm,
}, null, 2) + "\n");
console.log(`wrote ${OUT}`);
