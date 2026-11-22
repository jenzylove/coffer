// Coffer server: static web app, QoreChain REST proxy, relayer drip,
// public repo scanner, and a demo teammate that judges can share to and revoke.
// It never sees anyone's plain text: the teammate only reports key names of
// files explicitly shared with it.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, basename } from "node:path";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { existsSync, readFileSync } from "node:fs";
import type { Hex } from "viem";
import { fromBase64Url } from "@qorechain/qoreseal";
import { identityFromMnemonic } from "../src/core/identity.ts";
import { parseCoffer, verifyCoffer, openCoffer, checkHead, localSigner, CofferError } from "../src/core/vault.ts";
import { signCard, readerFromCard, type RecipientCard } from "../src/core/card.ts";
import { parseDotenv } from "../src/core/dotenv.ts";
import { scanDotenvx } from "../src/core/dotenvx.ts";
import { TESTNET, MIN_UQOR, accountStatus, fetchPqKeys, registerIdentity, sendTx, ChainError } from "../src/chain/qore.ts";
import { cardCall, headCall, readCard, readHead, type EvmNetwork } from "../src/chain/coffer.ts";
import { Poster, PosterError, POSTER_NET } from "./poster.ts";

const PORT = Number(process.env.PORT ?? 8787);
const net = TESTNET;
const DIST = join(import.meta.dirname, "..", "web", "dist");
const DRIP_UQOR = 250_000n; // setup (about 54,000) plus about ten shares or revokes (about 17,000 each)
const RELAYER_FLOOR = 200_000n;
const PER_IP_DAY = 5;
const GLOBAL_DAY = 300;

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const relayer = identityFromMnemonic(need("RELAYER_MNEMONIC"));
const teammate = identityFromMnemonic(need("TEAMMATE_MNEMONIC"));
const DEPLOYMENT = join(import.meta.dirname, "..", "deployments", "testnet.json");
const deployment = existsSync(DEPLOYMENT) ? JSON.parse(readFileSync(DEPLOYMENT, "utf8")) : {};
const CONTRACT = (process.env.COFFER_CONTRACT ?? deployment.coffer) as Hex | undefined;
const evmNet: EvmNetwork = { chainId: net.chainId, rest: net.rest, evm: POSTER_NET.evm, coffer: CONTRACT ?? "0x0000000000000000000000000000000000000000" };
const poster = process.env.POSTER_MNEMONIC ? await Poster.from(process.env.POSTER_MNEMONIC, CONTRACT) : null;
const CARDS_PER_IP_DAY = 5;
const HEADS_PER_IP_DAY = 25;
const POSTS_GLOBAL_DAY = 250; // about 25 QOR a day at most; the poster stops before it runs dry (POSTER_FLOOR)
const POSTER_FLOOR = 2_000_000n; // 2 QOR kept back so the demo teammate and judges are never stranded

// ---- helpers -------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function readBody(req: IncomingMessage, limit = 512 * 1024): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "body must be JSON"); }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function clientIp(req: IncomingMessage): string {
  // Railway's edge appends the real client address as the LAST X-Forwarded-For entry;
  // earlier entries come from the client and can be forged.
  const f = req.headers["x-forwarded-for"];
  const hops = (Array.isArray(f) ? f.join(",") : f ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] || req.socket.remoteAddress || "unknown";
}

// One transaction at a time from the relayer: sequence numbers must not race.
let relayQueue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = relayQueue.then(fn, fn);
  relayQueue = p.catch(() => undefined);
  return p;
}

// ---- drip ------------------------------------------------------------------------

const drips: { at: number; ip: string; address: string }[] = [];
const DAY = 24 * 3600 * 1000;

async function drip(req: IncomingMessage, res: ServerResponse) {
  const { address } = await readBody(req, 4096);
  if (typeof address !== "string" || !/^qor1[02-9ac-hj-np-z]{38,58}$/.test(address)) throw new HttpError(400, "send a qor1 address");
  const now = Date.now();
  while (drips.length && now - drips[0]!.at > DAY) drips.shift();
  const ip = clientIp(req);
  if (drips.some((d) => d.address === address)) throw new HttpError(429, "this address was already funded today");
  if (drips.filter((d) => d.ip === ip).length >= PER_IP_DAY) throw new HttpError(429, `limit reached: ${PER_IP_DAY} new addresses per day from one network`);
  if (drips.length >= GLOBAL_DAY) throw new HttpError(429, "the relayer's daily budget is used up; try tomorrow or use the faucet");
  // Reserve before any await so parallel requests cannot pass the checks twice.
  const slot = { at: now, ip, address };
  drips.push(slot);
  const release = () => { const i = drips.indexOf(slot); if (i >= 0) drips.splice(i, 1); };
  try {
    const st = await accountStatus(net, address);
    const setUp = st.mldsa && st.kem;
    if (setUp && st.uqor >= MIN_UQOR) throw new HttpError(409, "this address is set up and still has QOR");
    if (!setUp && st.uqor >= 60_000n) throw new HttpError(409, "this address already has enough QOR for setup");
    const rel = await accountStatus(net, relayer.address);
    if (rel.uqor < RELAYER_FLOOR + DRIP_UQOR) throw new HttpError(503, "the relayer is out of test QOR; the owner tops it up from the faucet");
    const t = await serial(() => sendTx(net, relayer, [{
      typeUrl: "/cosmos.bank.v1beta1.MsgSend",
      value: MsgSend.encode(MsgSend.fromPartial({ fromAddress: relayer.address, toAddress: address, amount: [{ denom: "uqor", amount: DRIP_UQOR.toString() }] })).finish(),
    }], { memo: "coffer drip: setup fees" }));
    send(res, 200, { hash: t.hash, uqor: DRIP_UQOR });
  } catch (e) {
    release();
    throw e;
  }
}

// ---- teammate ----------------------------------------------------------------------

async function teammateOpen(req: IncomingMessage, res: ServerResponse) {
  const { file } = await readBody(req);
  if (typeof file !== "string") throw new HttpError(400, "send { file: <.env.coffer text> }");
  try {
    const f = parseCoffer(file);
    if (f.chainId !== net.chainId) throw new CofferError("WRONG_CHAIN", `this file is for ${f.chainId}`);
    verifyCoffer(f, await fetchPqKeys(net, [f.owner, f.writer]));
    checkHead(f, await readHead(evmNet, f.id));
    const keys = parseDotenv(new TextDecoder().decode(openCoffer(f, teammate.sealKeys))).map((e) => e.key);
    send(res, 200, { opened: true, keys, epoch: f.epoch, version: f.version, verified: true });
  } catch (e) {
    if (e instanceof CofferError || e instanceof ChainError) return send(res, 200, { opened: false, code: e.code, error: e.message });
    throw e;
  }
}

// ---- cards and heads (the poster pays; signatures decide) -------------------------

const posts: { at: number; ip: string; kind: "card" | "head"; key: string }[] = [];

let posterChecked = { at: 0, ok: true };
async function posterHasFunds() {
  if (Date.now() - posterChecked.at < 60_000) return posterChecked.ok;
  const st = await accountStatus(net, poster!.address).catch(() => null);
  posterChecked = { at: Date.now(), ok: !st || st.uqor >= POSTER_FLOOR };
  return posterChecked.ok;
}

function postSlot(req: IncomingMessage, kind: "card" | "head", key: string) {
  if (!poster || !CONTRACT) throw new HttpError(503, "recording on QoreChain is not set up on this server");
  const now = Date.now();
  while (posts.length && now - posts[0]!.at > DAY) posts.shift();
  const ip = clientIp(req);
  const mine = posts.filter((p) => p.ip === ip && p.kind === kind).length;
  if (kind === "card" && mine >= CARDS_PER_IP_DAY) throw new HttpError(429, `limit reached: ${CARDS_PER_IP_DAY} cards per day from one network`);
  if (kind === "head" && mine >= HEADS_PER_IP_DAY) throw new HttpError(429, `limit reached: ${HEADS_PER_IP_DAY} changes per day from one network`);
  if (posts.length >= POSTS_GLOBAL_DAY) throw new HttpError(429, "today's budget for recording on QoreChain is used up; try tomorrow");
  // Reserve before any await so parallel requests cannot pass the checks twice.
  const slot = { at: now, ip, kind, key };
  posts.push(slot);
  return () => { const i = posts.indexOf(slot); if (i >= 0) posts.splice(i, 1); };
}

/** Publish a signed recipient card. Checked here first, then again by the contract on chain. */
async function postCard(req: IncomingMessage, res: ServerResponse) {
  const { card, mlkemKey } = await readBody(req, 64 * 1024);
  if (!card || typeof card !== "object" || typeof card.address !== "string" || typeof mlkemKey !== "string") throw new HttpError(400, "send { card, mlkemKey }");
  const release = postSlot(req, "card", card.address);
  try {
    if (!(await posterHasFunds())) throw new HttpError(503, "the Coffer server is low on test QOR for recording; the owner tops it up from the faucet. Try again later.");
    let key: Uint8Array;
    try { key = fromBase64Url(mlkemKey); } catch { throw new HttpError(400, "mlkemKey must be base64url"); }
    const pq = await fetchPqKeys(net, [card.address]);
    if (!pq[card.address]) throw new HttpError(400, `${card.address} has no ML-DSA-87 key on QoreChain yet: send one transaction from that wallet first`);
    try { readerFromCard({ card: card as RecipientCard, chainId: net.chainId, address: card.address, pqPublicKey: pq[card.address]!, mlkemPublicKey: key }); }
    catch (e) { throw new HttpError(400, `the card does not check out: ${(e as Error).message}`); }
    const c = cardCall(card as RecipientCard, key);
    const t = await poster!.call(c.functionName, c.args);
    send(res, 200, { hash: t.hash, block: t.block, contract: CONTRACT });
  } catch (e) {
    release();
    if (e instanceof PosterError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

/** Record the owner's signed change of a file. Checked here first, then again by the contract on chain. */
async function postHead(req: IncomingMessage, res: ServerResponse) {
  const { file } = await readBody(req);
  if (typeof file !== "string") throw new HttpError(400, "send { file: <.env.coffer text> }");
  let f;
  try {
    f = parseCoffer(file);
    if (f.chainId !== net.chainId) throw new CofferError("WRONG_CHAIN", `this file is for ${f.chainId}`);
    verifyCoffer(f, await fetchPqKeys(net, [f.owner, f.writer]));
  } catch (e) {
    if (e instanceof CofferError) throw new HttpError(400, e.message);
    throw e;
  }
  const release = postSlot(req, "head", f.id);
  try {
    if (!(await posterHasFunds())) throw new HttpError(503, "the Coffer server is low on test QOR for recording; the owner tops it up from the faucet. Try again later.");
    const h = headCall(f);
    const t = await poster!.call(h.functionName, h.args);
    send(res, 200, { hash: t.hash, block: t.block, contract: CONTRACT });
  } catch (e) {
    release();
    if (e instanceof PosterError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

// ---- EVM read proxy (the EVM RPC sends no CORS headers) ------------------------------

const EVM_READS = new Set(["eth_call", "eth_getLogs", "eth_blockNumber", "eth_chainId", "eth_getTransactionReceipt"]);
async function evmProxy(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req, 64 * 1024);
  if (!body || typeof body.method !== "string" || !EVM_READS.has(body.method)) throw new HttpError(400, "only read calls are allowed");
  const r = await fetch(POSTER_NET.evm, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, method: body.method, params: body.params ?? [] }) });
  res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

// ---- scanner -------------------------------------------------------------------------

type Kind = "dotenvx" | "plain" | "coffer" | "example";
interface ScanFile { path: string; kind: Kind; publicKey?: string; encrypted: number; plain: number; keys: string[] }
const scanCache = new Map<string, { at: number; body: unknown }>();

function gh(path: string) {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "coffer-scanner" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return fetch(`https://api.github.com${path}`, { headers });
}

const ENV_NAME = /^\.env(\.[\w.-]+)?$|^[\w.-]+\.env$/;
const EXAMPLE = /(example|sample|template|dist|defaults?)(\.|$)/i;

async function scan(req: IncomingMessage, res: ServerResponse, url: URL) {
  const raw = (url.searchParams.get("repo") ?? "").trim();
  const m = raw.match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/);
  if (!m) throw new HttpError(400, "paste a public GitHub repo, like owner/name or its github.com link");
  const repo = `${m[1]}/${m[2]}`;
  const hit = scanCache.get(repo.toLowerCase());
  if (hit && Date.now() - hit.at < 10 * 60_000) return send(res, 200, hit.body);
  const meta = await gh(`/repos/${repo}`);
  if (meta.status === 404) throw new HttpError(404, "no public repo by that name");
  if (meta.status === 403 || meta.status === 429) throw new HttpError(503, "GitHub's rate limit for scans is used up for now; try again in a few minutes");
  if (!meta.ok) throw new HttpError(502, `GitHub answered ${meta.status}`);
  const info = (await meta.json()) as any;
  if (info.private) throw new HttpError(400, "that repo is private");
  const branch: string = info.default_branch;
  const tr = await gh(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (!tr.ok) throw new HttpError(502, `GitHub answered ${tr.status} for the file list`);
  const tree = (await tr.json()) as any;
  const paths: string[] = (tree.tree ?? [])
    .filter((t: any) => t.type === "blob" && t.size < 200_000 && (ENV_NAME.test(basename(t.path)) || basename(t.path).endsWith(".coffer")) && !t.path.includes("node_modules/"))
    .map((t: any) => t.path)
    .slice(0, 25);
  const files: ScanFile[] = [];
  await Promise.all(paths.map(async (p) => {
    const r = await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${p.split("/").map(encodeURIComponent).join("/")}`);
    if (!r.ok) return;
    const text = await r.text();
    if (p.endsWith(".coffer") || text.startsWith("# Sealed by Coffer")) {
      files.push({ path: p, kind: "coffer", encrypted: 0, plain: 0, keys: [] });
      return;
    }
    const s = scanDotenvx(text);
    const keys = [...s.encryptedKeys, ...s.plainKeys];
    if (!keys.length && !s.isDotenvx) return;
    const kind: Kind = s.isDotenvx ? "dotenvx" : EXAMPLE.test(basename(p)) ? "example" : "plain";
    files.push({ path: p, kind, ...(s.publicKey ? { publicKey: s.publicKey } : {}), encrypted: s.encryptedKeys.length, plain: s.plainKeys.length, keys });
  }));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const body = { repo, branch, files, truncated: !!tree.truncated };
  if (scanCache.size >= 500) scanCache.delete(scanCache.keys().next().value!);
  scanCache.set(repo.toLowerCase(), { at: Date.now(), body });
  send(res, 200, body);
}

// ---- REST proxy --------------------------------------------------------------------

async function proxy(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname.slice("/rest".length);
  if (!/^\/(cosmos|qorechain)\//.test(path)) throw new HttpError(404, "not a QoreChain REST path");
  if (req.method !== "GET" && req.method !== "POST") throw new HttpError(405, "method not allowed");
  const body = req.method === "POST" ? Buffer.from(JSON.stringify(await readBody(req, 2 * 1024 * 1024))) : undefined;
  const r = await fetch(`${net.rest}${path}${url.search}`, { method: req.method, headers: body ? { "content-type": "application/json" } : {}, body });
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

// ---- static ------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4",
};

async function serveStatic(res: ServerResponse, pathname: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, "bad URL"); }
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, safe);
  if (!file.startsWith(DIST)) throw new HttpError(404, "not found");
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(DIST, "index.html"); // SPA routes
  }
  try {
    const data = await readFile(file);
    const immutable = file.includes(`${join(DIST, "assets")}`);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("web app not built");
  }
}

// ---- routing -------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/api/drip" && req.method === "POST") return await drip(req, res);
    if (url.pathname === "/api/scan" && req.method === "GET") return await scan(req, res, url);
    if (url.pathname === "/api/teammate" && req.method === "GET") return send(res, 200, { address: teammate.address });
    if (url.pathname === "/api/card" && req.method === "POST") return await postCard(req, res);
    if (url.pathname === "/api/head" && req.method === "POST") return await postHead(req, res);
    if (url.pathname === "/api/config" && req.method === "GET") return send(res, 200, { chainId: net.chainId, contract: CONTRACT ?? null, poster: poster?.address ?? null, teammate: teammate.address });
    if (url.pathname === "/evm" && req.method === "POST") return await evmProxy(req, res);
    if (url.pathname === "/api/teammate/open" && req.method === "POST") return await teammateOpen(req, res);
    if (url.pathname === "/api/stats" && req.method === "GET") {
      const rel = await accountStatus(net, relayer.address);
      const pos = poster ? await accountStatus(net, poster.address) : null;
      return send(res, 200, {
        relayer: { address: relayer.address, uqor: rel.uqor }, poster: pos ? { address: pos.address, uqor: pos.uqor } : null, contract: CONTRACT ?? null,
        drips24h: drips.filter((d) => Date.now() - d.at < DAY).length, posts24h: posts.length, teammate: teammate.address,
      });
    }
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/rest/")) return await proxy(req, res, url);
    if (url.pathname.startsWith("/api/")) throw new HttpError(404, "no such endpoint");
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    return await serveStatic(res, url.pathname);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof ChainError ? 502 : 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : "server error" });
  }
});

// The demo teammate needs its keys registered and a card on chain before anyone can share to it.
(async () => {
  // The chain refuses transactions from accounts with no ML-DSA key, so the relayer registers first.
  await serial(() => registerIdentity(net, relayer, (s, t) => console.log(`relayer: ${s}${t ? ` ${t.hash}` : ""}`)));
  const st = await accountStatus(net, teammate.address, teammate.sealKeys.mlkemPublicKey);
  if (!(st.mldsa && st.kemIsOurs)) {
    if (st.uqor < 60_000n) {
      const t = await serial(() => sendTx(net, relayer, [{
        typeUrl: "/cosmos.bank.v1beta1.MsgSend",
        value: MsgSend.encode(MsgSend.fromPartial({ fromAddress: relayer.address, toAddress: teammate.address, amount: [{ denom: "uqor", amount: "200000" }] })).finish(),
      }], { memo: "coffer: fund demo teammate" }));
      console.log(`teammate: funded ${t.hash}`);
      for (let i = 0; i < 20 && (await accountStatus(net, teammate.address)).uqor < 60_000n; i++) await new Promise((ok) => setTimeout(ok, 1500));
    }
    await registerIdentity(net, teammate, (s, t) => console.log(`teammate: ${s}${t ? ` ${t.hash}` : ""}`));
  }
  if (!poster || !CONTRACT) return console.log("teammate: keys ready; no contract configured, so no card");
  await poster.ensureRegistered();
  const have = await readCard(evmNet, teammate.address).catch(() => null);
  if (have && have.card.x25519PublicKey === Buffer.from(teammate.sealKeys.x25519PublicKey).toString("hex")) return console.log("teammate: ready, card on chain");
  const card = await signCard(net.chainId, localSigner(teammate), teammate.sealKeys);
  const c = cardCall(card, teammate.sealKeys.mlkemPublicKey);
  const t = await poster.call(c.functionName, c.args);
  console.log(`teammate: card published ${t.hash}`);
})().catch((e) => console.error(`teammate setup failed: ${e.message} (teammate ${teammate.address}, poster ${poster?.address})`));

server.listen(PORT, () => console.log(`coffer server on :${PORT} · relayer ${relayer.address} · teammate ${teammate.address} · poster ${poster?.address ?? "none"} · contract ${CONTRACT ?? "none"}`));
