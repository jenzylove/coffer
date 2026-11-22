// All heavy crypto runs here, off the main thread: ML-KEM key generation,
// sealing and opening, ML-DSA signing and checking, cards, and every QoreChain
// read. Same functions the CLI uses (src/core, src/chain); nothing reimplemented.
//
// A wallet account (QoreX) signs through the page: its Signer posts the text
// to sign to crypto.ts, which asks QoreX and posts the signature back.
import type { SealKeyPair } from "@qorechain/qoreseal";
import { sealKeysFromSeed, parseEnvelope, recipientHint, toBase64Url } from "@qorechain/qoreseal";
import type { MessageSignature } from "@qorechain/qoresign";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { decodeEventLog, encodeEventTopics, toHex, type Hex } from "viem";
import {
  createCoffer, shareCoffer, revokeCoffer, openCoffer, verifyCoffer, checkHead, formatCoffer, parseCoffer, localSigner,
  CofferError, hex, type Reader, type Signer,
} from "../../../src/core/vault.ts";
import { signCard } from "../../../src/core/card.ts";
import { identityFromMnemonic, newMnemonic, type Identity } from "../../../src/core/identity.ts";
import { parseDotenv, serializeDotenv } from "../../../src/core/dotenv.ts";
import { accountStatus, fetchPqKeys, registerIdentity, type Network } from "../../../src/chain/qore.ts";
import { COFFER_ABI, evmAddress, fetchReader, qorAddress, readCard, readHead, rpc, type EvmNetwork } from "../../../src/chain/coffer.ts";

const CHAIN = "qorechain-diana";
// QoreChain goes through our own server (/rest, /evm); relative URLs resolve to this origin in the worker too
const NET: Network = { chainId: CHAIN, rest: "/rest" };

let evmNet: Promise<EvmNetwork> | null = null;
/** The Coffer contract's address comes from the server (GET /api/config). */
function evm(): Promise<EvmNetwork> {
  if (!evmNet) {
    evmNet = (async () => {
      const r = await fetch("/api/config").catch(() => null);
      const b = r?.ok ? ((await r.json().catch(() => null)) as { contract?: string | null } | null) : null;
      if (!b?.contract) throw new CofferError("NO_CONTRACT", "recording on QoreChain is not set up on this server yet");
      return { chainId: CHAIN, rest: "/rest", evm: "/evm", coffer: b.contract as Hex };
    })();
    evmNet.catch(() => { evmNet = null; }); // ask again next time
  }
  return evmNet;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

// ---- signing: a local key here, or the wallet through the page --------------------

export type OwnerRef = { kind: "local"; id: Identity } | { kind: "wallet"; address: string };

let signSeq = 0;
const signWaits = new Map<number, { ok: (s: MessageSignature) => void; fail: (e: Error) => void }>();
const b64 = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };

function signerFor(o: OwnerRef, opId: number): Signer {
  if (o.kind === "local") return localSigner(o.id);
  return {
    address: o.address,
    sign: (chainId, data) => new Promise<MessageSignature>((ok, fail) => {
      const req = ++signSeq;
      signWaits.set(req, { ok, fail });
      post({ id: opId, sign: { req, chainId, address: o.address, dataB64: b64(data) } });
    }),
  };
}

// ---- cards ------------------------------------------------------------------------

type CardState = { state: "none" } | { state: "ours" | "other"; height: number };

/** The account's card on chain, and whether it names these keys. */
async function cardState(address: string, keys?: Pick<SealKeyPair, "mlkemPublicKey" | "x25519PublicKey"> | null): Promise<CardState> {
  const c = await readCard(await evm(), address);
  if (!c) return { state: "none" };
  const ours = !!keys && c.card.x25519PublicKey === hex(keys.x25519PublicKey) && c.card.mlkemKeySha3 === hex(sha3_256(keys.mlkemPublicKey));
  return { state: ours ? "ours" : "other", height: c.height };
}

// ---- landing story: three throwaway identities (you, Ada, Sam) -----------------
type Who = "you" | "one" | "two";
type DemoFile = Awaited<ReturnType<typeof createCoffer>>;
let demo: { ids: Record<Who, Identity>; file?: DemoFile } | null = null;
function demoIds() {
  if (!demo) { const make = () => identityFromMnemonic(newMnemonic()); demo = { ids: { you: make(), one: make(), two: make() } }; }
  return demo;
}
function canOpen(f: DemoFile) {
  const out: Partial<Record<Who, "open" | "refused">> = {};
  for (const w of ["you", "one", "two"] as Who[]) {
    try { openCoffer(f, demo!.ids[w].sealKeys); out[w] = "open"; }
    catch (e) { if ((e as { code?: string }).code === "NOT_A_READER") out[w] = "refused"; else throw e; }
  }
  return out;
}
const namesOf = (p: Uint8Array) => parseDotenv(dec.decode(p)).map((e) => e.key);
const readerOf = (i: Identity): Reader => ({ address: i.address, mlkemPublicKey: i.sealKeys.mlkemPublicKey, x25519PublicKey: i.sealKeys.x25519PublicKey });

type Ctx = { progress: (text: string, hash?: string) => void; opId: number };
type OwnerArgs = { owner: OwnerRef; keys: SealKeyPair };

const ops: Record<string, (a: any, ctx: Ctx) => unknown> = {
  // ---- QoreChain: reads and setup, all off the main thread ----
  /** Balance, signing key, KEM key, and the card: one round trip for the setup screens. */
  async status({ address, keys }: { address: string; keys?: SealKeyPair | null }) {
    const [st, card] = await Promise.all([
      accountStatus(NET, address, keys?.mlkemPublicKey),
      cardState(address, keys).catch((e: { code?: string; message?: string }) => ({ state: "error" as const, code: e?.code, message: e?.message ?? String(e) })),
    ]);
    return { uqor: st.uqor, pq: st.mldsa, kemIsOurs: st.kemIsOurs, card };
  },
  cardState: ({ address, keys }: { address: string; keys?: SealKeyPair | null }) => cardState(address, keys),
  /** Has this address signed a card? (Verified against its key on chain.) */
  async hasCard({ address }: { address: string }) {
    return !!(await readCard(await evm(), address));
  },
  registerIdentity: ({ id }: { id: Identity }, ctx) => registerIdentity(NET, id, (s, tx) => ctx.progress(s, tx?.hash)),
  /** Sign this account's recipient card (one wallet approval) and return what POST /api/card takes. */
  async signCard({ owner, keys }: OwnerArgs, ctx) {
    const card = await signCard(CHAIN, signerFor(owner, ctx.opId), keys);
    return { card, mlkemKey: toBase64Url(keys.mlkemPublicKey) };
  },
  async readHead({ fileId }: { fileId: string }) {
    return readHead(await evm(), fileId);
  },
  /** The checks a reader runs: signatures against keys on chain, then the file's head on chain. */
  async check({ text }: { text: string }) {
    const f = parseCoffer(text);
    if (f.chainId !== CHAIN) throw new CofferError("WRONG_CHAIN", `this file is for ${f.chainId}`);
    verifyCoffer(f, await fetchPqKeys(NET, [f.owner, f.writer]));
    const head = await readHead(await evm(), f.id);
    checkHead(f, head);
    return { head };
  },
  /** Readers whose current card is not the one this file is sealed to (they made a new key). */
  async changedReaders({ text }: { text: string }) {
    const f = parseCoffer(text);
    let env;
    try { env = parseEnvelope(f.key); } catch { return []; }
    if (env.anonymous) return [];
    const net = await evm();
    const out: string[] = [];
    await Promise.all(f.readers.filter((a) => a !== f.owner).map(async (a) => {
      const c = await readCard(net, a).catch(() => null);
      if (!c) return;
      const h = recipientHint(env.salt, c.reader.mlkemPublicKey);
      if (!env.entries.some((e) => e.hint.length === h.length && e.hint.every((x, i) => x === h[i]))) out.push(a);
    }));
    return out.sort();
  },
  /** What the proof page shows: the contract, the demo teammate's card transaction, the newest file head. */
  async proofFacts({ teammate }: { teammate?: string | null }) {
    const net = await evm();
    const out: {
      contract: string;
      card: { block: number; hash: string | null; issuedAt: string } | null;
      head: { file: string; owner: string; epoch: bigint; version: bigint; block: number; hash: string; current: Awaited<ReturnType<typeof readHead>> } | null;
    } = { contract: net.coffer, card: null, head: null };
    type Log = { data: Hex; topics: Hex[]; transactionHash: Hex; blockNumber: Hex };
    if (teammate) {
      const c = await readCard(net, teammate).catch(() => null);
      if (c) {
        const topics = encodeEventTopics({ abi: COFFER_ABI, eventName: "CardSet", args: { account: evmAddress(teammate) } });
        const logs = await rpc<Log[]>(net.evm, "eth_getLogs", [{ address: net.coffer, fromBlock: toHex(c.height), toBlock: toHex(c.height), topics }]).catch(() => []);
        out.card = { block: c.height, hash: logs[logs.length - 1]?.transactionHash ?? null, issuedAt: c.card.issuedAt };
      }
    }
    const latest = Number(await rpc<Hex>(net.evm, "eth_blockNumber", []));
    const topics = encodeEventTopics({ abi: COFFER_ABI, eventName: "HeadSet" });
    for (let to = latest, i = 0; i < 24 && to > 0; i++) {
      const from = Math.max(0, to - 4999);
      const logs = await rpc<Log[]>(net.evm, "eth_getLogs", [{ address: net.coffer, fromBlock: toHex(from), toBlock: toHex(to), topics }]).catch(() => [] as Log[]);
      const l = logs[logs.length - 1];
      if (l) {
        const ev = decodeEventLog({ abi: COFFER_ABI, eventName: "HeadSet", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        const file = ev.args.file.slice(2).toLowerCase();
        out.head = { file, owner: qorAddress(ev.args.owner), epoch: ev.args.epoch, version: ev.args.version, block: Number(l.blockNumber), hash: l.transactionHash, current: await readHead(net, file) };
        break;
      }
      to = from - 1;
    }
    return out;
  },

  /** The story's people: you (owner), Ada and Sam. Real throwaway identities. */
  demoInit() {
    const d = demoIds();
    return { you: d.ids.you.address, ada: d.ids.one.address, sam: d.ids.two.address };
  },
  async demoSeal({ env }: { env: string }) {
    const d = demoIds();
    const entries = parseDotenv(env);
    if (!entries.length) throw new Error("Write at least one line like NAME=value first.");
    d.file = await createCoffer({ chainId: CHAIN, name: ".env", owner: localSigner(d.ids.you), ownerKeys: d.ids.you.sealKeys, plaintext: enc.encode(serializeDotenv(entries)) });
    return { can: canOpen(d.file), count: entries.length, text: formatCoffer(d.file) };
  },
  async demoShare() {
    const ids = demo!.ids;
    demo!.file = await shareCoffer(demo!.file!, localSigner(ids.you), ids.you.sealKeys, [readerOf(ids.one), readerOf(ids.two)]);
    // what Ada reads once she is a reader: the real decrypted lines
    const ada = dec.decode(openCoffer(demo!.file, ids.one.sealKeys)).split("\n").filter(Boolean);
    return { can: canOpen(demo!.file), text: formatCoffer(demo!.file), ada };
  },
  async demoRevoke() {
    const ids = demo!.ids;
    const { file, rotate } = await revokeCoffer(demo!.file!, localSigner(ids.you), ids.you.sealKeys, [ids.two.address], namesOf);
    demo!.file = file;
    return { can: canOpen(file), rotate, text: formatCoffer(file) };
  },
  demoRun() {
    const ids = demo!.ids, f = demo!.file!;
    const pq = Object.fromEntries((["you", "one", "two"] as Who[]).map((w) => [ids[w].address, ids[w].pqKey.publicKey]));
    verifyCoffer(f, pq);
    const names = namesOf(openCoffer(f, ids.one.sealKeys));
    let tamperRefused = false;
    try { verifyCoffer({ ...f, readers: [...f.readers, ids.two.address] }, pq); } catch { tamperRefused = true; }
    return { names, tamperRefused };
  },

  // ---- the app ----
  newPhrase: () => newMnemonic(),
  identity: ({ phrase }: { phrase: string }) => identityFromMnemonic(phrase),
  sealKeys: ({ seed }: { seed: Uint8Array }) => sealKeysFromSeed(seed),
  async create({ name, owner, keys, env }: OwnerArgs & { name: string; env: string }, ctx) {
    const plaintext = enc.encode(serializeDotenv(parseDotenv(env)));
    return formatCoffer(await createCoffer({ chainId: CHAIN, name, owner: signerFor(owner, ctx.opId), ownerKeys: keys, plaintext }));
  },
  /** Seal the file to more addresses: each one's reader keys come from its verified card on chain. */
  async shareTo({ text, owner, keys, addresses }: OwnerArgs & { text: string; addresses: string[] }, ctx) {
    const net = await evm();
    const readers = await Promise.all(addresses.map((a) => fetchReader(net, a)));
    return formatCoffer(await shareCoffer(parseCoffer(text), signerFor(owner, ctx.opId), keys, readers));
  },
  async revoke({ text, owner, keys, addresses }: OwnerArgs & { text: string; addresses: string[] }, ctx) {
    const { file, rotate } = await revokeCoffer(parseCoffer(text), signerFor(owner, ctx.opId), keys, addresses, namesOf);
    return { text: formatCoffer(file), rotate };
  },
  open({ text, keys }: { text: string; keys: SealKeyPair }) {
    return parseDotenv(dec.decode(openCoffer(parseCoffer(text), keys)));
  },
};

type FromPage =
  | { id: number; op: string; args: unknown; signReply?: undefined }
  | { signReply: { req: number; sig?: MessageSignature; error?: string; code?: string } };

self.onmessage = async (e: MessageEvent<FromPage>) => {
  if (e.data.signReply) {
    const r = e.data.signReply;
    const w = signWaits.get(r.req);
    if (!w) return;
    signWaits.delete(r.req);
    if (r.sig) w.ok(r.sig);
    else w.fail(new CofferError(r.code ?? "WALLET_ERROR", r.error ?? "the wallet did not sign"));
    return;
  }
  const { id, op, args } = e.data;
  try {
    const fn = ops[op];
    if (!fn) throw new Error(`unknown operation ${op}`);
    const progress = (text: string, hash?: string) => post({ id, progress: { text, hash } });
    post({ id, ok: true, value: await fn(args, { progress, opId: id }) });
  } catch (err) {
    const x = err as { message?: string; code?: string };
    post({ id, ok: false, message: x?.message ?? String(err), code: x?.code });
  }
};
