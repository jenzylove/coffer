// The stolen laptop attack, as an outside judge ran it against Coffer on 23 Nov 2026, so anyone can
// rerun it. Inputs: what a thief finds on a reader's laptop (the identity file with the reader's
// recovery phrase, and a .env.coffer copy). No request to the keeper, no call to the Coffer server,
// no open() on the contract: only public eth_getLogs reads of every Opened event for that reader and
// file, then local decryption with the stolen key.
//
//   node scripts/log-replay.mts <identity file> <.env.coffer copy>
//
// Exit 0: nothing opened (each release was sealed to a reply key made for one open and thrown away).
// Exit 1: the stolen key opened a release or the copy.
import { readFileSync } from "node:fs";
import { decodeEventLog, encodeEventTopics, hexToBytes, toHex, type Hex } from "viem";
import { identityFromMnemonic } from "../src/core/identity.ts";
import { parseCoffer, openCoffer, openReleaseTo, CofferError, type OpenRequest } from "../src/core/vault.ts";
import { COFFER_ABI, evmAddress } from "../src/chain/coffer.ts";
import { COFFER_CONTRACT, EVM_TESTNET } from "../src/chain/deployment.ts";

const [idFile, copyFile] = process.argv.slice(2);
if (!idFile || !copyFile) {
  console.error("usage: node scripts/log-replay.mts <identity file> <.env.coffer copy>");
  process.exit(2);
}
const contract = (process.env.COFFER_CONTRACT ?? COFFER_CONTRACT) as Hex;
const evm = process.env.COFFER_EVM ?? EVM_TESTNET;
const id = identityFromMnemonic(readFileSync(idFile, "utf8"));
const f = parseCoffer(readFileSync(copyFile, "utf8"));

const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  const r = await fetch(evm, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const b = (await r.json()) as { result?: T; error?: unknown };
  if (b.error) throw new Error(JSON.stringify(b.error));
  return b.result as T;
};

console.log(`stolen key: ${id.address}`);
console.log(`copy on the laptop: file ${f.id}, epoch ${f.epoch}, version ${f.version}`);
const topics = encodeEventTopics({ abi: COFFER_ABI, eventName: "Opened", args: { file: `0x${f.id}` as Hex, reader: evmAddress(id.address) } });
const latest = BigInt(await rpc<Hex>("eth_blockNumber", []));
const from = BigInt(process.env.FROM_BLOCK ?? (latest > 200_000n ? latest - 200_000n : 0n));
type Log = { data: Hex; topics: Hex[]; blockNumber: Hex; transactionHash: Hex };
const logs: Log[] = [];
for (let a = from; a <= latest; a += 10_000n) {
  const b = a + 9_999n > latest ? latest : a + 9_999n;
  logs.push(...(await rpc<Log[]>("eth_getLogs", [{ address: contract, topics, fromBlock: toHex(a), toBlock: toHex(b) }])));
}
console.log(`public Opened events for this reader and file (blocks ${from} to ${latest}): ${logs.length}`);

let opened = 0;
for (const l of logs) {
  const ev = decodeEventLog({ abi: COFFER_ABI, eventName: "Opened", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
  const request: OpenRequest = { file: f.id, epoch: ev.args.epoch, version: ev.args.version, reader: id.address, replyKey: ev.args.replyKey.slice(2), nonce: ev.args.nonce };
  try {
    const piece = openReleaseTo({ chainId: f.chainId, request, sealed: hexToBytes(ev.args.release), replyKeys: id.sealKeys });
    opened++;
    console.log(`  block ${BigInt(l.blockNumber)} (epoch ${ev.args.epoch}, version ${ev.args.version}): the release OPENED with the stolen key`);
    if (ev.args.epoch === f.epoch && ev.args.version === f.version) {
      console.log("  and it opens the copy:\n" + new TextDecoder().decode(openCoffer(f, id.sealKeys, piece)));
    }
  } catch (e) {
    const why = e instanceof CofferError ? e.message : String(e);
    console.log(`  block ${BigInt(l.blockNumber)} (epoch ${ev.args.epoch}, version ${ev.args.version}) tx ${l.transactionHash}: does not open (${why})`);
  }
}
console.log(opened ? `RESULT: the stolen key opened ${opened} release(s)` : `RESULT: ${logs.length} release(s) on the public log, none opens with the stolen key`);
process.exit(opened ? 1 : 0);
