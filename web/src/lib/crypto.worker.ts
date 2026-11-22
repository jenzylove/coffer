// All heavy crypto runs here, off the main thread: ML-KEM key generation,
// sealing and opening, ML-DSA signing and checking, cards, and every QoreChain
// read. Same functions the CLI uses (src/core, src/chain); nothing reimplemented.
//
// A wallet account (QoreX) signs through the page: its Signer posts the text
// to sign to crypto.ts, which asks QoreX and posts the signature back.
import type { SealKeyPair } from "@qorechain/qoreseal";
import { sealKeysFromSeed, parseEnvelope, recipientHint, toBase64Url, fromBase64Url } from "@qorechain/qoreseal";
import { pqKeyFromSeed } from "@qorechain/qoresign";
import type { MessageSignature } from "@qorechain/qoresign";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { decodeEventLog, encodeEventTopics, toHex, type Hex } from "viem";
import {
  createCoffer, shareCoffer, revokeCoffer, openCoffer, verifyCoffer, checkHead, formatCoffer, parseCoffer, localSigner,
  ownerRelease, canRead, signOpen, newNonce, openReleaseTo, keeperOpenRelease, deviceText, deviceId,
  CofferError, hex, type CofferFile, type Reader, type Signer,
} from "../../../src/core/vault.ts";
import { signCard } from "../../../src/core/card.ts";
import { identityFromMnemonic, newMnemonic, type Identity } from "../../../src/core/identity.ts";
import { parseDotenv, serializeDotenv } from "../../../src/core/dotenv.ts";
import { accountStatus, fetchPqKeys, registerIdentity, type Network } from "../../../src/chain/qore.ts";
import {
  COFFER_ABI, blockNumber, deviceUntil, evmAddress, fetchReader, filesOf, qorAddress, readCard, readFile, readHead, readOpens, rpc,
  type DeliveredFile, type EvmNetwork,
} from "../../../src/chain/coffer.ts";

const CHAIN = "qorechain-diana";
// QoreChain goes through our own server (/rest, /evm); relative URLs resolve to this origin in the worker too
const NET: Network = { chainId: CHAIN, rest: "/rest" };

let config: Promise<{ net: EvmNetwork; keeper: string | null }> | null = null;
/** The Coffer contract and the keeper come from the server (GET /api/config). */
function serverConfig() {
  if (!config) {
    config = (async () => {
      const r = await fetch("/api/config").catch(() => null);
      const b = r?.ok ? ((await r.json().catch(() => null)) as { contract?: string | null; keeper?: string | null } | null) : null;
      if (!b?.contract) throw new CofferError("NO_CONTRACT", "recording on QoreChain is not set up on this server yet");
      return { net: { chainId: CHAIN, rest: "/rest", evm: "/evm", coffer: b.contract as Hex }, keeper: b.keeper ?? null };
    })();
    config.catch(() => { config = null; }); // ask again next time
  }
  return config;
}
const evm = async () => (await serverConfig()).net;

let keeperCache: Promise<Reader> | null = null;
/** The file keeper's reader keys, from its card on chain: release pieces are sealed to it. */
function keeperReader(): Promise<Reader> {
  if (!keeperCache) {
    keeperCache = (async () => {
      const c = await serverConfig();
      if (!c.keeper) throw new CofferError("NO_KEEPER", "this server has no keeper, so files cannot be opened through QoreChain here");
      return fetchReader(c.net, c.keeper);
    })();
    keeperCache.catch(() => { keeperCache = null; });
  }
  return keeperCache;
}

/** Send a signed open request; the contract refuses (403) anyone not on the file's current list. */
async function askToOpen(f: CofferFile, reader: string, keys: SealKeyPair, by: { device: Uint8Array } | { account: Signer }) {
  const req = { file: f.id, epoch: f.epoch, reader, nonce: newNonce() };
  const device = "device" in by ? pqKeyFromSeed(by.device) : null;
  const sig = await signOpen(CHAIN, req, device ? { device } : { account: (by as { account: Signer }).account });
  const r = await fetch("/api/open", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      file: f.id, epoch: f.epoch.toString(), reader, nonce: req.nonce.toString(), sig: toBase64Url(sig), release: toBase64Url(f.release),
      ...(device ? { deviceKey: toBase64Url(device.publicKey) } : {}),
    }),
  }).catch(() => null);
  const b = r ? ((await r.json().catch(() => ({}))) as { hash?: string; block?: number; sealed?: string; error?: string }) : {};
  if (!r) throw new CofferError("SERVER_DOWN", "the Coffer server is not reachable right now");
  if (r.status === 403) throw new CofferError("REFUSED_BY_CHAIN", b.error ?? "QoreChain refused to release this file");
  if (!r.ok || !b.sealed) throw new CofferError("NOT_OPENED", b.error ?? `the server answered ${r.status}`);
  const release = openReleaseTo({ chainId: CHAIN, file: f.id, epoch: f.epoch, reader, nonce: req.nonce, sealed: fromBase64Url(b.sealed), keys });
  return { release, hash: b.hash ?? null, block: b.block ?? null };
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

const delivered = new Map<string, DeliveredFile & { hash: string | null }>();

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
// a throwaway keeper too: in the story it stands in for the chain's release
let demo: { ids: Record<Who, Identity>; keeper: Identity; file?: DemoFile } | null = null;
function demoIds() {
  if (!demo) { const make = () => identityFromMnemonic(newMnemonic()); demo = { ids: { you: make(), one: make(), two: make() }, keeper: make() }; }
  return demo;
}
function canOpen(f: DemoFile) {
  const out: Partial<Record<Who, "open" | "refused">> = {};
  for (const w of ["you", "one", "two"] as Who[]) out[w] = canRead(f, demo!.ids[w].sealKeys) ? "open" : "refused";
  return out;
}
/** What a reader on the list reads in the story: the keeper releases this epoch's piece to them. */
function demoOpen(f: DemoFile, who: Identity) {
  const release = keeperOpenRelease({ chainId: CHAIN, file: f.id, epoch: f.epoch, envelope: f.release, keeperKeys: demo!.keeper.sealKeys });
  return openCoffer(f, who.sealKeys, release);
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
  /**
   * Every file this address is or was a reader of, newest first, each with its
   * latest sealed copy from QoreChain. A copy is read again only when its head moved.
   */
  async inbox({ address }: { address: string }) {
    const net = await evm();
    const ids = await filesOf(net, address);
    const items = await Promise.all(ids.map(async (id) => {
      const head = await readHead(net, id);
      if (!head) return null;
      let d = delivered.get(id);
      if (!d || d.height !== head.height || d.epoch !== head.epoch) {
        const got = await readFile(net, id);
        if (!got) return null;
        // the transaction that delivered this copy, for the explorer link
        const topics = encodeEventTopics({ abi: COFFER_ABI, eventName: "HeadSet", args: { file: `0x${id}` as Hex } });
        const logs = await rpc<{ transactionHash: Hex }[]>(net.evm, "eth_getLogs", [{ address: net.coffer, fromBlock: toHex(got.height), toBlock: toHex(got.height), topics }]).catch(() => []);
        d = { ...got, hash: logs[logs.length - 1]?.transactionHash ?? null };
        delivered.set(id, d);
      }
      let readers: string[] = [];
      try { readers = parseCoffer(d.text).readers; } catch { return null; }
      return { id, name: d.name, owner: d.owner, epoch: d.epoch, version: d.version, height: d.height, text: d.text, readers, hash: d.hash };
    }));
    return items.filter((x) => x !== null).reverse();
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
    d.file = await createCoffer({ chainId: CHAIN, name: ".env", owner: localSigner(d.ids.you), ownerKeys: d.ids.you.sealKeys, keeper: readerOf(d.keeper), plaintext: enc.encode(serializeDotenv(entries)) });
    return { can: canOpen(d.file), count: entries.length, text: formatCoffer(d.file) };
  },
  async demoShare() {
    const ids = demo!.ids;
    demo!.file = await shareCoffer(demo!.file!, localSigner(ids.you), ids.you.sealKeys, readerOf(demo!.keeper), [readerOf(ids.one), readerOf(ids.two)]);
    // what Ada reads once she is a reader: the real decrypted lines
    const ada = dec.decode(demoOpen(demo!.file, ids.one)).split("\n").filter(Boolean);
    return { can: canOpen(demo!.file), text: formatCoffer(demo!.file), ada };
  },
  async demoRevoke() {
    const ids = demo!.ids;
    const { file, rotate } = await revokeCoffer(demo!.file!, localSigner(ids.you), ids.you.sealKeys, readerOf(demo!.keeper), [ids.two.address], namesOf);
    demo!.file = file;
    return { can: canOpen(file), rotate, text: formatCoffer(file) };
  },
  demoRun() {
    const ids = demo!.ids, f = demo!.file!;
    const pq = Object.fromEntries((["you", "one", "two"] as Who[]).map((w) => [ids[w].address, ids[w].pqKey.publicKey]));
    verifyCoffer(f, pq);
    const names = namesOf(demoOpen(f, ids.one));
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
    const keeper = await keeperReader();
    return formatCoffer(await createCoffer({ chainId: CHAIN, name, owner: signerFor(owner, ctx.opId), ownerKeys: keys, keeper, plaintext }));
  },
  /** Seal the file to more addresses: each one's reader keys come from its verified card on chain. */
  async shareTo({ text, owner, keys, addresses }: OwnerArgs & { text: string; addresses: string[] }, ctx) {
    const net = await evm();
    const readers = await Promise.all(addresses.map((a) => fetchReader(net, a)));
    return formatCoffer(await shareCoffer(parseCoffer(text), signerFor(owner, ctx.opId), keys, await keeperReader(), readers));
  },
  async revoke({ text, owner, keys, addresses }: OwnerArgs & { text: string; addresses: string[] }, ctx) {
    const { file, rotate } = await revokeCoffer(parseCoffer(text), signerFor(owner, ctx.opId), keys, await keeperReader(), addresses, namesOf);
    return { text: formatCoffer(file), rotate };
  },
  /** The owner opens with its own copy of the release piece: no request, nothing recorded. */
  ownerOpen({ text, keys }: { text: string; keys: SealKeyPair }) {
    const f = parseCoffer(text);
    return parseDotenv(dec.decode(openCoffer(f, keys, ownerRelease(f, keys))));
  },
  /**
   * A reader opens: checks (unless `checks` is false, for a copy kept from before), a signed request to
   * QoreChain, the release piece sealed back to this key, then the values. Every such open is recorded.
   * QoreX users sign with an approved device key (no popup); a browser key signs with the account itself.
   */
  async readerOpen({ text, reader, keys, by, checks = true }: { text: string; reader: string; keys: SealKeyPair; by: { kind: "device"; seed: Uint8Array } | { kind: "account"; owner: OwnerRef }; checks?: boolean }, ctx) {
    const f = parseCoffer(text);
    if (f.chainId !== CHAIN) throw new CofferError("WRONG_CHAIN", `this file is for ${f.chainId}`);
    if (checks) {
      verifyCoffer(f, await fetchPqKeys(NET, [f.owner, f.writer]));
      checkHead(f, await readHead(await evm(), f.id));
    }
    if (!canRead(f, keys)) throw new CofferError("NOT_A_READER", "this identity is not a reader of this file");
    if (f.owner === reader) return { entries: parseDotenv(dec.decode(openCoffer(f, keys, ownerRelease(f, keys)))), hash: null, block: null };
    const o = await askToOpen(f, reader, keys, by.kind === "device" ? { device: by.seed } : { account: signerFor(by.owner, ctx.opId) });
    return { entries: parseDotenv(dec.decode(openCoffer(f, keys, o.release))), hash: o.hash, block: o.block };
  },
  /** Is this browser's device key approved for the wallet right now? */
  async deviceStatus({ address, seed }: { address: string; seed: Uint8Array }) {
    const net = await evm();
    const pk = pqKeyFromSeed(seed).publicKey;
    const [until, now] = await Promise.all([deviceUntil(net, address, pk), blockNumber(net)]);
    return { until, now, live: until > now + 120n };
  },
  /** Approve this browser's device key for about a day: one wallet signature, recorded by the contract. */
  async approveDevice({ address, seed, owner }: { address: string; seed: Uint8Array; owner: OwnerRef }, ctx) {
    const net = await evm();
    const pk = pqKeyFromSeed(seed).publicKey;
    const until = (await blockNumber(net)) + 60_000n;
    const sig = await signerFor(owner, ctx.opId).sign(CHAIN, enc.encode(deviceText({ account: address, id: deviceId(pk), untilBlock: until })));
    if (!sig.pq) throw new CofferError("BAD_SIGNATURE", "the wallet gave no ML-DSA-87 signature");
    const r = await fetch("/api/device", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: address, deviceKey: toBase64Url(pk), until: until.toString(), sig: sig.pq.signature }),
    }).catch(() => null);
    const b = r ? ((await r.json().catch(() => ({}))) as { hash?: string; block?: number; error?: string }) : {};
    if (!r?.ok) throw new CofferError("DEVICE_REFUSED", b.error ?? "the Coffer server is not reachable right now");
    for (let i = 0; i < 20 && (await deviceUntil(net, address, pk)) < until; i++) await new Promise((ok) => setTimeout(ok, 1500));
    return { hash: b.hash ?? null, block: b.block ?? null, until };
  },
  /** The access log: every open of a file, newest first, each with the transaction that recorded it. */
  async opens({ fileId }: { fileId: string }) {
    const net = await evm();
    const rows = await readOpens(net, fileId);
    const blocks = [...new Set(rows.map((r) => r.block))];
    const hashes = new Map<string, string>();
    await Promise.all(blocks.map(async (b) => {
      const topics = encodeEventTopics({ abi: COFFER_ABI, eventName: "Opened", args: { file: `0x${fileId}` as Hex } });
      const logs = await rpc<{ data: Hex; topics: Hex[]; transactionHash: Hex }[]>(net.evm, "eth_getLogs", [{ address: net.coffer, fromBlock: toHex(b), toBlock: toHex(b), topics }]).catch(() => []);
      for (const l of logs) {
        try {
          const ev = decodeEventLog({ abi: COFFER_ABI, eventName: "Opened", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
          hashes.set(`${b}:${qorAddress(ev.args.reader)}:${ev.args.epoch}`, l.transactionHash);
        } catch { /* not an Opened log */ }
      }
    }));
    return rows.map((r) => ({ ...r, hash: hashes.get(`${r.block}:${r.reader}:${r.epoch}`) ?? null })).reverse();
  },
};

void evmAddress;

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
