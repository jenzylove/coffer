// The Coffer contract on QoreChain's EVM: recipient cards and file heads.
// Reads go straight to the EVM JSON-RPC (eth_call, eth_getLogs); writes are
// signed by the account (card) or the owner (head) and submitted by anyone,
// here the Coffer server, which pays the gas. Works in Node and the browser.
import {
  bytesToHex, decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData,
  getAddress, hexToBytes, parseAbi, toHex, type Hex,
} from "viem";
import { addressFromBytes, parseAddress } from "@qorechain/qoresign";
import { fetchPqKeyStatus } from "@qorechain/qoresign/network";
import { isQoreSealError } from "@qorechain/qoreseal";
import { readerFromCard, type RecipientCard } from "../core/card.ts";
import { CofferError, type ChainHead, type CofferFile, type Reader, headArgs } from "../core/vault.ts";

export const COFFER_ABI = parseAbi([
  "function chainId() view returns (string)",
  "function cards(address) view returns (bytes32 mlkemSha3, bytes32 x25519, bytes32 issuedAt, uint64 height)",
  "function heads(bytes16) view returns (address owner, uint64 epoch, uint64 version, uint64 height, bytes32 access, bytes32 data)",
  "function setCard(address account, bytes32 mlkemSha3, bytes32 x25519, string issuedAt, bytes pqSig, bytes mlkemKey, bytes card)",
  "function setHead(bytes16 file, address owner, uint64 epoch, uint64 version, bytes32 access, bytes32 data, string note, bytes pqSig)",
  "function cardText(address account, bytes32 mlkemSha3, bytes32 x25519, string issuedAt) view returns (bytes)",
  "function changeText(bytes16 file, uint64 epoch, uint64 version, bytes32 access, bytes32 data, string note) pure returns (bytes)",
  "event CardSet(address indexed account, bytes32 mlkemSha3, bytes32 x25519, string issuedAt, bytes mlkemKey, bytes card)",
  "event HeadSet(bytes16 indexed file, address indexed owner, uint64 epoch, uint64 version, bytes32 access, bytes32 data, string note)",
  "error NoProvenKey(address account)",
  "error BadSignature()",
  "error BadIssuedAt()",
  "error StaleCard()",
  "error BadKeyLength()",
  "error NotOwner(address owner)",
  "error StaleEpoch(uint64 current)",
  "error NoteTooLong()",
  "error PrecompileInactive()",
]);

export interface EvmNetwork {
  chainId: string;
  /** QoreChain REST (ML-DSA-87 keys). */
  rest: string;
  /** QoreChain EVM JSON-RPC. */
  evm: string;
  /** The Coffer contract. */
  coffer: Hex;
}

/** qor1… to the same account's 0x address. */
export const evmAddress = (qor1: string): Hex => getAddress(bytesToHex(parseAddress(qor1).bytes));
/** 0x… to the same account's qor1 address. */
export const qorAddress = (hex: Hex): string => addressFromBytes(hexToBytes(hex)).bech32;

let rpcId = 0;
export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  if (!r.ok) throw new CofferError("EVM_ERROR", `QoreChain EVM RPC ${r.status} on ${method}`);
  const b = (await r.json()) as { result?: T; error?: { message: string; data?: Hex } };
  if (b.error) {
    const why = refusalText(b.error.data);
    throw Object.assign(new CofferError(why ? "REFUSED" : "EVM_ERROR", why ? `QoreChain refused it: ${why}` : `QoreChain EVM RPC: ${b.error.message}`), { data: b.error.data });
  }
  return b.result as T;
}

async function call<F extends "cards" | "heads">(net: EvmNetwork, functionName: F, args: readonly unknown[]) {
  const data = encodeFunctionData({ abi: COFFER_ABI, functionName, args } as never);
  const out = await rpc<Hex>(net.evm, "eth_call", [{ to: net.coffer, data }, "latest"]);
  if (!out || out === "0x") throw new CofferError("EVM_ERROR", "the Coffer contract did not answer (wrong network or address)");
  return decodeFunctionResult({ abi: COFFER_ABI, functionName, data: out } as never) as unknown as readonly unknown[];
}

const hex32 = (h: Hex) => h.slice(2).toLowerCase();
const b64ToHex = (b64: string): Hex => bytesToHex(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

// ---- cards ----------------------------------------------------------------------

export interface ChainCard { reader: Reader; card: RecipientCard; height: number }

/**
 * The account's current card from the contract, checked again here against
 * its ML-DSA-87 key on chain. null if the account has never published one.
 */
export async function readCard(net: EvmNetwork, address: string): Promise<ChainCard | null> {
  if (!/^qor1[02-9ac-hj-np-z]{38,58}$/.test(address)) throw new CofferError("BAD_ADDRESS", `${address} is not a qor1 address`);
  const account = evmAddress(address);
  const [mlkemSha3, x25519, issuedAt, height] = (await call(net, "cards", [account])) as [Hex, Hex, Hex, bigint];
  if (height === 0n) return null;
  const topics = encodeEventTopics({ abi: COFFER_ABI, eventName: "CardSet", args: { account } });
  const logs = await rpc<{ data: Hex; topics: Hex[] }[]>(net.evm, "eth_getLogs", [{ address: net.coffer, fromBlock: toHex(height), toBlock: toHex(height), topics }]);
  const stamp = new TextDecoder().decode(hexToBytes(issuedAt).slice(0, 20));
  for (const log of logs.reverse()) {
    const ev = decodeEventLog({ abi: COFFER_ABI, eventName: "CardSet", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    if (ev.args.issuedAt !== stamp || ev.args.mlkemSha3 !== mlkemSha3 || ev.args.x25519 !== x25519) continue;
    let card: RecipientCard;
    try { card = JSON.parse(new TextDecoder().decode(hexToBytes(ev.args.card))); } catch { break; }
    if (card.mlkemKeySha3 !== hex32(mlkemSha3) || card.x25519PublicKey !== hex32(x25519) || card.issuedAt !== stamp) break;
    const pq = await fetchPqKeyStatus({ rest: net.rest, address });
    if (!pq.registered || !pq.publicKey) throw new CofferError("UNKNOWN_KEY", `no ML-DSA-87 key on chain for ${address}`);
    try {
      return { reader: readerFromCard({ card, chainId: net.chainId, address, pqPublicKey: pq.publicKey, mlkemPublicKey: hexToBytes(ev.args.mlkemKey) }), card, height: Number(height) };
    } catch (e) {
      if (isQoreSealError(e, "CARD_INVALID")) throw new CofferError("CARD_INVALID", `the card on chain for ${address} does not check out: ${(e as Error).message}`);
      throw e;
    }
  }
  throw new CofferError("CARD_INVALID", `the card recorded for ${address} could not be read back from the chain`);
}

/** A reader to seal to, from the address alone. Throws NO_CARD if they have not published a card. */
export async function fetchReader(net: EvmNetwork, address: string): Promise<Reader> {
  const c = await readCard(net, address);
  if (!c) throw new CofferError("NO_CARD", `${address} has not set up Coffer yet: it has no card on QoreChain`);
  return c.reader;
}

/** The arguments for setCard, from a signed card and the ML-KEM key it names. */
export function cardCall(card: RecipientCard, mlkemPublicKey: Uint8Array) {
  if (!card.signature.pq) throw new CofferError("BAD_SIGNATURE", "the card has no ML-DSA-87 signature");
  return {
    functionName: "setCard" as const,
    args: [
      evmAddress(card.address), `0x${card.mlkemKeySha3}` as Hex, `0x${card.x25519PublicKey}` as Hex, card.issuedAt,
      b64ToHex(card.signature.pq.signature), bytesToHex(mlkemPublicKey), bytesToHex(new TextEncoder().encode(JSON.stringify(card))),
    ] as const,
  };
}

// ---- heads ----------------------------------------------------------------------

/** The file's head on chain, or null if it was never recorded. */
export async function readHead(net: EvmNetwork, fileId: string): Promise<ChainHead | null> {
  if (!/^[0-9a-f]{32}$/.test(fileId)) throw new CofferError("BAD_FORMAT", "bad file id");
  const [owner, epoch, version, height, access, data] = (await call(net, "heads", [`0x${fileId}`])) as [Hex, bigint, bigint, bigint, Hex, Hex];
  if (BigInt(owner) === 0n) return null;
  return { owner: qorAddress(owner), epoch, version, access: hex32(access), data: hex32(data), height: Number(height) };
}

/** The arguments for setHead, from the owner's signed change in the file. */
export function headCall(f: CofferFile) {
  const h = headArgs(f);
  if (!h.pqSig) throw new CofferError("BAD_SIGNATURE", "the owner's change has no ML-DSA-87 signature");
  return {
    functionName: "setHead" as const,
    args: [`0x${h.file}` as Hex, evmAddress(h.owner), h.epoch, h.version, `0x${h.access}` as Hex, `0x${h.data}` as Hex, h.note, b64ToHex(h.pqSig)] as const,
  };
}

/** A contract refusal in plain words, or null if `data` is not one of ours. */
export function refusalText(data: Hex | undefined): string | null {
  if (!data || data === "0x") return null;
  try {
    const e = decodeErrorResult({ abi: COFFER_ABI, data });
    switch (e.errorName) {
      case "NoProvenKey": return `${qorAddress(e.args![0] as Hex)} has no proven ML-DSA-87 key on QoreChain`;
      case "BadSignature": return "the signature does not match";
      case "BadIssuedAt": return "the card's date is not in the right form";
      case "StaleCard": return "a newer card is already on chain";
      case "BadKeyLength": return "the encryption key has the wrong length";
      case "NotOwner": return `this file belongs to ${qorAddress(e.args![0] as Hex)}`;
      case "StaleEpoch": return `QoreChain already has a newer change of this file (epoch ${e.args![0]})`;
      case "NoteTooLong": return "the note is too long";
      case "PrecompileInactive": return "QoreChain's post-quantum precompiles are not active on this network";
    }
  } catch { /* not ours */ }
  return null;
}

