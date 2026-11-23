#!/usr/bin/env node
// coffer: .env files sealed to QoreChain addresses.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { identityFromMnemonic, newMnemonic, type Identity } from "../core/identity.ts";
import {
  createCoffer, openCoffer, shareCoffer, revokeCoffer, updateCoffer, verifyCoffer, checkHead, localSigner,
  ownerRelease, openReleaseTo, signOpen, newNonce, newReplyKeys, type OpenRequest,
  formatCoffer, parseCoffer, CofferError, type CofferFile,
} from "../core/vault.ts";
import { signCard } from "../core/card.ts";
import { fromBase64Url, toBase64Url } from "@qorechain/qoreseal";
import { parseDotenv, serializeDotenv, toRecord, type DotenvEntry } from "../core/dotenv.ts";
import { importDotenvx, scanDotenvx } from "../core/dotenvx.ts";
import {
  TESTNET, accountStatus, fetchPqKeys, registerIdentity, MIN_UQOR,
  ChainError, type Network, type TxResult,
} from "../chain/qore.ts";
import { fetchReader, filesOf, readCard, readFile, readHead, readOpens, type EvmNetwork } from "../chain/coffer.ts";
import { COFFER_CONTRACT, COFFER_SERVER, EVM_TESTNET } from "../chain/deployment.ts";
import type { Hex } from "viem";

const net: Network = { ...TESTNET, rest: process.env.COFFER_REST ?? TESTNET.rest };
const evmNet: EvmNetwork = { chainId: net.chainId, rest: net.rest, evm: process.env.COFFER_EVM ?? EVM_TESTNET, coffer: (process.env.COFFER_CONTRACT ?? COFFER_CONTRACT) as Hex };
const HOME = process.env.COFFER_HOME ?? join(homedir(), ".coffer");
const ID_FILE = join(HOME, "identity");
const SEEN_FILE = join(HOME, "seen.json");
const PINS_FILE = join(HOME, "owners.json");
const SERVER = (process.env.COFFER_SERVER ?? process.env.COFFER_RELAYER?.replace(/\/api\/drip$/, "") ?? COFFER_SERVER).replace(/\/$/, "");
const RELAYER = `${SERVER}/api/drip`;
const contractUrl = (hash: string) => `https://dashboard.qorechain.io/explorer/tx/${hash}`;

/** Ask the Coffer server to submit a signed card or change to the contract (it pays the gas, it cannot forge either). */
async function post(path: "/api/card" | "/api/head" | "/api/write", body: unknown): Promise<{ hash: string; block: number }> {
  const r = await fetch(`${SERVER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const b = r ? ((await r.json().catch(() => ({}))) as any) : {};
  if (!r?.ok) throw new ChainError("NOT_RECORDED", `QoreChain did not record it${b.error ? `: ${b.error}` : r ? ` (server ${r.status})` : ": the Coffer server is not reachable"}`);
  return b;
}

/** Record the owner's change on chain. Called before the file is written, so no unrecorded copy exists. */
async function recordHead(f: CofferFile) {
  const t = await post("/api/head", { file: formatCoffer(f) });
  say(`  recorded on QoreChain: ${t.hash}  ${c.dim(contractUrl(t.hash))}`);
}
/** Record a new version written under the current readers (the contract checks the writer is on the list). */
async function recordWrite(f: CofferFile) {
  const t = await post("/api/write", { file: formatCoffer(f) });
  say(`  recorded on QoreChain: ${t.hash}  ${c.dim(contractUrl(t.hash))}`);
}
const enc = new TextEncoder();
const dec = new TextDecoder();

const c = {
  dim: (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
};
const say = (s = "") => console.log(s);
const txLine = (label: string, t: TxResult) => say(`  ${label}: ${t.hash}  ${c.dim(net.explorerTx?.(t.hash) ?? "")}`);

// ---- args -------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const dd = argv.indexOf("--");
  const own = dd >= 0 ? argv.slice(0, dd) : argv;
  const rest = dd >= 0 ? argv.slice(dd + 1) : [];
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < own.length; i++) {
    const a = own[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (["file", "f", "keys", "to"].includes(k) && own[i + 1] && !own[i + 1]!.startsWith("-")) flags[k] = own[++i]!;
      else flags[k] = true;
    } else if (a === "-f" && own[i + 1]) flags.file = own[++i]!;
    else pos.push(a);
  }
  return { cmd: pos[0], pos: pos.slice(1), flags, rest };
}

// ---- identity -----------------------------------------------------------------

function loadIdentity(): Identity {
  const fromEnv = process.env.COFFER_IDENTITY;
  if (fromEnv) return identityFromMnemonic(fromEnv);
  if (!existsSync(ID_FILE)) throw new CofferError("NO_IDENTITY", `no Coffer identity yet. Run "coffer init" first.`);
  return identityFromMnemonic(readFileSync(ID_FILE, "utf8"));
}

function createIdentity(): Identity {
  mkdirSync(HOME, { recursive: true });
  const m = newMnemonic();
  writeFileSync(ID_FILE, m + "\n", { mode: 0o600 });
  try { chmodSync(ID_FILE, 0o600); } catch { /* Windows */ }
  return identityFromMnemonic(m);
}

// ---- files ---------------------------------------------------------------------

const sealedName = (plain: string) => (plain.endsWith(".coffer") ? plain : `${plain}.coffer`);
const plainName = (sealed: string) => basename(sealed).replace(/\.coffer$/, "");

function resolveSealed(flags: Record<string, string | true>): string {
  const f = typeof flags.file === "string" ? flags.file : ".env.coffer";
  return sealedName(f);
}

function readSealed(path: string): CofferFile {
  if (!existsSync(path)) throw new CofferError("NO_FILE", `${path} not found. Seal a file first with "coffer lock".`);
  return parseCoffer(readFileSync(path, "utf8"));
}

function writeSealed(path: string, f: CofferFile) {
  writeFileSync(path, formatCoffer(f));
  remember(f);
}

// local high-water mark: refuse a file older than one this machine already saw
type Seen = Record<string, { epoch: string; version: string }>;
function seen(): Seen {
  try { return JSON.parse(readFileSync(SEEN_FILE, "utf8")); } catch { return {}; }
}
function remember(f: CofferFile) {
  const s = seen();
  s[f.id] = { epoch: f.epoch.toString(), version: f.version.toString() };
  mkdirSync(HOME, { recursive: true });
  writeFileSync(SEEN_FILE, JSON.stringify(s, null, 2));
}

// Owner pins: the first owner this machine sees at a path is remembered. A file
// that turns up later at the same path with a different owner is refused: anyone
// with write access to the repo could otherwise replace it with a file they own,
// sealed to you, and read whatever you write into it next.
type Pins = Record<string, string>;
function pins(): Pins {
  try { return JSON.parse(readFileSync(PINS_FILE, "utf8")); } catch { return {}; }
}
function pin(path: string, owner: string) {
  const p = pins();
  p[resolve(path)] = owner;
  mkdirSync(HOME, { recursive: true });
  writeFileSync(PINS_FILE, JSON.stringify(p, null, 2));
}
function checkOwner(path: string, f: CofferFile, accept: boolean) {
  const known = pins()[resolve(path)];
  if (known && known !== f.owner && !accept) {
    throw new CofferError("OWNER_CHANGED", `${path} used to belong to ${known}; this copy belongs to ${f.owner}. Someone may have replaced the file to read what you write next. If the owner really changed, run again with --accept-owner.`);
  }
  if (!known) console.error(c.dim(`owner of ${path}: ${f.owner} (first time on this machine; make sure this is your teammate)`));
  pin(path, f.owner);
}

/** Signatures against chain keys, the owner pin, the chain's grant record, and the local high-water mark. */
async function checkFile(f: CofferFile, opts: { offline?: boolean; path?: string; acceptOwner?: boolean } = {}) {
  if (opts.path) checkOwner(opts.path, f, !!opts.acceptOwner);
  if (opts.offline) {
    console.error(c.red("warning: --offline skips the signature and rollback checks against QoreChain"));
    return;
  }
  const keys = await fetchPqKeys(net, [f.owner, f.writer]);
  verifyCoffer(f, keys);
  try {
    checkHead(f, await readHead(evmNet, f.id));
  } catch (e) {
    if (e instanceof CofferError && e.code === "UNRECORDED") throw new CofferError("UNRECORDED", `${e.message}. Coffer records every change before writing the file, so this copy was not made by Coffer or its record failed. The owner can run "coffer record".`);
    throw e;
  }
  const s = seen()[f.id];
  if (s && (f.epoch < BigInt(s.epoch) || (f.epoch === BigInt(s.epoch) && f.version < BigInt(s.version)))) {
    throw new CofferError("ROLLBACK", `this machine already saw epoch ${s.epoch} version ${s.version} of this file; this copy is older (epoch ${f.epoch} version ${f.version})`);
  }
}

/** The file's keeper, as a reader to seal its release pieces to (its card, checked against the chain). */
async function keeperReader() {
  const r = await fetch(`${SERVER}/api/config`).catch(() => null);
  const cfg = r?.ok ? ((await r.json()) as { keeper?: string | null }) : null;
  if (!cfg?.keeper) throw new ChainError("NO_KEEPER", `the Coffer server at ${SERVER} has no keeper to hand out release pieces`);
  return fetchReader(evmNet, cfg.keeper);
}

/**
 * The release piece for this version: the owner holds its own copy; a reader asks with a request
 * naming this version and a reply key made for this one open, and the contract refuses unless the
 * reader is on the current list. The reply key lives only in memory here, so the release recorded
 * on QoreChain can never be opened again, not even with this identity file.
 */
async function releaseFor(f: CofferFile, id: Identity): Promise<Uint8Array> {
  if (id.address === f.owner) {
    try { return ownerRelease(f, id.sealKeys); } catch { /* a writer sealed the owner's copy to an old card: ask like any reader */ }
  }
  const reply = newReplyKeys();
  const req: OpenRequest = { file: f.id, epoch: f.epoch, version: f.version, reader: id.address, replyKey: reply.id, nonce: newNonce() };
  const sig = await signOpen(net.chainId, req, { account: localSigner(id) });
  const r = await fetch(`${SERVER}/api/open`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...req, epoch: req.epoch.toString(), version: req.version.toString(), nonce: req.nonce.toString(), sig: toBase64Url(sig), release: toBase64Url(f.release),
      replyMlkem: toBase64Url(reply.keys.mlkemPublicKey), replyX25519: toBase64Url(reply.keys.x25519PublicKey),
    }),
  }).catch(() => null);
  const b = r ? ((await r.json().catch(() => ({}))) as any) : {};
  if (!r?.ok) throw new ChainError(r?.status === 403 ? "REFUSED_BY_CHAIN" : "NOT_OPENED", `QoreChain did not release this file to you${b.error ? `: ${b.error}` : r ? ` (server ${r.status})` : ": the Coffer server is not reachable"}`);
  console.error(c.dim(`opened through QoreChain: ${b.hash}`));
  return openReleaseTo({ chainId: net.chainId, request: req, sealed: fromBase64Url(b.sealed), replyKeys: reply.keys });
}

/** A new version of the values: sealed with its own release piece, signed by this identity, recorded on QoreChain. */
async function writeValues(f: CofferFile, id: Identity, entries: DotenvEntry[]) {
  const g = await updateCoffer(f, localSigner(id), id.sealKeys, await keeperReader(), await fetchReader(evmNet, f.owner), enc.encode(serializeDotenv(entries)));
  await recordWrite(g);
  return g;
}

async function entriesOf(f: CofferFile, id: Identity): Promise<DotenvEntry[]> {
  return parseDotenv(dec.decode(openCoffer(f, id.sealKeys, await releaseFor(f, id))));
}

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** This identity's card is the current one on chain, so readers seal to keys it holds. */
async function cardIsOurs(id: Identity) {
  const have = await readCard(evmNet, id.address).catch(() => null);
  return !!have && have.card.x25519PublicKey === hexOf(id.sealKeys.x25519PublicKey) && have.card.mlkemKeySha3 === hexOf(await sha3(id.sealKeys.mlkemPublicKey));
}
async function sha3(b: Uint8Array) {
  const { sha3_256 } = await import("@noble/hashes/sha3.js");
  return sha3_256(b);
}

async function ensureReady(id: Identity) {
  const st = await accountStatus(net, id.address, id.sealKeys.mlkemPublicKey);
  if (!st.mldsa || !(await cardIsOurs(id))) throw new CofferError("NOT_REGISTERED", `your address is not set up on QoreChain yet. Run "coffer init".`);
}

const owner = (id: Identity) => ({ signer: localSigner(id), keys: id.sealKeys });

// ---- commands ----------------------------------------------------------------

async function init() {
  let id: Identity;
  if (process.env.COFFER_IDENTITY || existsSync(ID_FILE)) {
    id = loadIdentity();
    say(`identity  ${c.bold(id.address)}  ${c.dim(process.env.COFFER_IDENTITY ? "(from COFFER_IDENTITY)" : ID_FILE)}`);
  } else {
    id = createIdentity();
    say(`new identity  ${c.bold(id.address)}`);
    say(c.dim(`  saved to ${ID_FILE}. This file opens every Coffer file shared with you: back it up and never commit it.`));
  }
  let st = await accountStatus(net, id.address, id.sealKeys.mlkemPublicKey);
  const ready = st.mldsa && st.kemIsOurs;
  if (ready && st.uqor >= MIN_UQOR) { await publishCard(id); return; }
  if (st.uqor < (ready ? MIN_UQOR : 60_000n)) {
    say(ready ? `topping up from the Coffer relayer...` : `funding the two setup transactions from the Coffer relayer...`);
    const r = await fetch(RELAYER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: id.address }) }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) as any : {};
    if (!r?.ok) {
      throw new ChainError("NO_FUNDS", `the relayer could not fund ${id.address}${body.error ? `: ${body.error}` : ""}. Send 0.1 test QOR to it (faucet: https://dashboard.qorechain.io/faucet) and run "coffer init" again.`);
    }
    if (body.hash) txLine("funded", { hash: body.hash } as TxResult);
    for (let i = 0; i < 30 && st.uqor < (ready ? MIN_UQOR : 60_000n); i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      st = await accountStatus(net, id.address, id.sealKeys.mlkemPublicKey);
    }
  }
  const out = await registerIdentity(net, id, (s, t) => (t ? txLine(s, t) : say(c.dim(`  ${s}...`))));
  void out;
  await publishCard(id);
}

/** Sign this identity's recipient card and have it recorded in the Coffer contract (the contract checks the signature). */
async function publishCard(id: Identity) {
  if (await cardIsOurs(id)) { say(c.green("ready: anyone can seal files to this address")); return; }
  say(c.dim("  signing your recipient card (ML-KEM-1024 + X25519 keys) with ML-DSA-87..."));
  const card = await signCard(net.chainId, localSigner(id), id.sealKeys);
  const t = await post("/api/card", { card, mlkemKey: toBase64Url(id.sealKeys.mlkemPublicKey) });
  say(`  card recorded on QoreChain: ${t.hash}  ${c.dim(contractUrl(t.hash))}`);
  say(c.green("ready: anyone can seal files to this address"));
}

async function whoami() {
  const id = loadIdentity();
  const st = await accountStatus(net, id.address, id.sealKeys.mlkemPublicKey);
  const card = await cardIsOurs(id);
  say(id.address);
  say(c.dim(`  ${Number(st.uqor) / 1e6} QOR · ML-DSA-87 key ${st.mldsa ? "registered" : "missing"} · ML-KEM-1024 key ${st.kemIsOurs ? "in the KEM registry" : st.kem ? "different key in the registry" : "not in the registry"} · card ${card ? "on chain" : "missing"}`));
}

async function lock(pos: string[], flags: Record<string, string | true>) {
  const plain = pos[0] ?? (typeof flags.file === "string" ? flags.file.replace(/\.coffer$/, "") : ".env");
  const sealedPath = sealedName(plain);
  if (!existsSync(plain)) throw new CofferError("NO_FILE", `${plain} not found`);
  const text = readFileSync(plain, "utf8");
  if (scanDotenvx(text).isDotenvx) throw new CofferError("IS_DOTENVX", `${plain} is dotenvx-encrypted. Use "coffer import ${plain}" to move it.`);
  const entries = parseDotenv(text);
  const id = loadIdentity();
  await ensureReady(id);
  if (existsSync(sealedPath)) {
    if (typeof flags.to === "string") throw new CofferError("USAGE", `${sealedPath} already exists; add readers with "coffer share <qor1...>"`);
    const f = readSealed(sealedPath);
    await checkFile(f, { path: sealedPath, acceptOwner: flags["accept-owner"] === true });
    const g = await writeValues(f, id, entries);
    writeSealed(sealedPath, g);
    say(`${c.green("sealed")} ${entries.length} values into ${sealedPath} ${c.dim(`(version ${g.version}, readers unchanged: ${g.readers.length})`)}`);
  } else {
    const to = typeof flags.to === "string" ? flags.to.split(",") : [];
    const readers = await Promise.all(to.map((a) => fetchReader(evmNet, a.trim())));
    const o = owner(id);
    const f = await createCoffer({ chainId: net.chainId, name: plainName(sealedPath), owner: o.signer, ownerKeys: o.keys, keeper: await keeperReader(), readers, plaintext: enc.encode(serializeDotenv(entries)) });
    say(`${c.green("sealed")} ${entries.length} values into ${sealedPath}`);
    await recordHead(f);
    writeSealed(sealedPath, f);
    pin(sealedPath, f.owner);
  }
  say(c.dim(`  commit ${sealedPath}. You can delete ${plain} once your team has it; "coffer run" never needs it.`));
}

async function run(flags: Record<string, string | true>, rest: string[]) {
  if (!rest.length) throw new CofferError("USAGE", `usage: coffer run [-f .env.coffer] -- <command>`);
  const path = resolveSealed(flags);
  const f = readSealed(path);
  await checkFile(f, { offline: flags.offline === true, path, acceptOwner: flags["accept-owner"] === true });
  const id = loadIdentity();
  const vars = toRecord(await entriesOf(f, id));
  remember(f);
  runChild(rest, { ...process.env, ...vars });
}

// Spawn without a shell. On Windows, commands like npm are .cmd files that need
// one; then pass a single, properly quoted command line.
function runChild(argv: string[], env: NodeJS.ProcessEnv, viaShell = false) {
  const quote = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`);
  const child = viaShell
    ? spawn(argv.map(quote).join(" "), { stdio: "inherit", env, shell: true })
    : spawn(argv[0]!, argv.slice(1), { stdio: "inherit", env });
  child.on("error", (e: NodeJS.ErrnoException) => {
    if (!viaShell && process.platform === "win32" && (e.code === "ENOENT" || e.code === "EINVAL")) return runChild(argv, env, true);
    console.error(c.red(`coffer: could not start ${argv[0]}: ${e.message}`));
    process.exit(127);
  });
  child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
}

async function share(pos: string[], flags: Record<string, string | true>) {
  if (!pos.length) throw new CofferError("USAGE", "usage: coffer share <qor1 address>... [-f .env.coffer]");
  const path = resolveSealed(flags);
  const f = readSealed(path);
  await checkFile(f, { path: path, acceptOwner: flags["accept-owner"] === true });
  const id = loadIdentity();
  const readers = await Promise.all(pos.map((a) => fetchReader(evmNet, a)));
  const g = await shareCoffer(f, localSigner(id), id.sealKeys, await keeperReader(), readers);
  say(`${c.green("shared")} ${path} with ${readers.length} reader(s); epoch ${g.epoch}`);
  await recordHead(g);
  writeSealed(path, g);
  say(c.dim(`  commit ${path} so they get it.`));
}

async function revoke(pos: string[], flags: Record<string, string | true>) {
  if (!pos.length) throw new CofferError("USAGE", "usage: coffer revoke <qor1 address>... [-f .env.coffer]");
  const path = resolveSealed(flags);
  const f = readSealed(path);
  await checkFile(f, { path: path, acceptOwner: flags["accept-owner"] === true });
  const id = loadIdentity();
  const { file, rotate } = await revokeCoffer(f, localSigner(id), id.sealKeys, await keeperReader(), pos, (p: Uint8Array) => parseDotenv(dec.decode(p)).map((e) => e.key));
  say(`${c.green("revoked")} ${pos.length} reader(s); epoch ${file.epoch}. They cannot open this or any later version.`);
  await recordHead(file);
  writeSealed(path, file);
  say();
  say(c.bold("They may still have the values they already read. Rotate these at the provider:"));
  for (const k of rotate) say(`  ${k}`);
  say(c.dim(`  then: coffer set KEY -f ${path}   (asks for the new value)`));
}

async function importCmd(pos: string[], flags: Record<string, string | true>) {
  const envPath = pos[0] ?? ".env";
  const keysPath = typeof flags.keys === "string" ? flags.keys : ".env.keys";
  if (!existsSync(envPath)) throw new CofferError("NO_FILE", `${envPath} not found`);
  if (!existsSync(keysPath)) throw new CofferError("NO_FILE", `${keysPath} not found (pass --keys <path>)`);
  const scan = scanDotenvx(readFileSync(envPath, "utf8"));
  if (!scan.isDotenvx) throw new CofferError("NOT_DOTENVX", `${envPath} is not dotenvx-encrypted. Use "coffer lock ${envPath}".`);
  const imp = importDotenvx(readFileSync(envPath, "utf8"), readFileSync(keysPath, "utf8"));
  const id = loadIdentity();
  await ensureReady(id);
  const sealedPath = sealedName(envPath);
  if (existsSync(sealedPath)) throw new CofferError("EXISTS", `${sealedPath} already exists`);
  const to = typeof flags.to === "string" ? flags.to.split(",") : [];
  const readers = await Promise.all(to.map((a) => fetchReader(evmNet, a.trim())));
  const o = owner(id);
  const f = await createCoffer({ chainId: net.chainId, name: plainName(sealedPath), owner: o.signer, ownerKeys: o.keys, keeper: await keeperReader(), readers, plaintext: enc.encode(serializeDotenv(imp.entries)) });
  say(`${c.green("moved")} ${imp.entries.length} values from dotenvx (secp256k1) to ${sealedPath} (ML-KEM-1024 + X25519)`);
  await recordHead(f);
  writeSealed(sealedPath, f);
  pin(sealedPath, f.owner);
  say(c.dim(`  the dotenvx copy in your git history stays readable to anyone with ${keysPath}, and to a quantum computer later. Rotate these values when you can.`));
}

async function setCmd(pos: string[], flags: Record<string, string | true>, unset = false) {
  if (!pos.length) throw new CofferError("USAGE", unset ? "usage: coffer unset KEY..." : "usage: coffer set KEY (asks for the value) or KEY=value");
  const path = resolveSealed(flags);
  const f = readSealed(path);
  await checkFile(f, { path: path, acceptOwner: flags["accept-owner"] === true });
  const id = loadIdentity();
  const release = await releaseFor(f, id);
  const entries = parseDotenv(dec.decode(openCoffer(f, id.sealKeys, release)));
  for (const p of pos) {
    if (unset) {
      const i = entries.findIndex((e) => e.key === p);
      if (i < 0) throw new CofferError("NO_KEY", `${p} is not in ${path}`);
      entries.splice(i, 1);
    } else {
      const eq = p.indexOf("=");
      // KEY alone: ask for the value so it never lands in shell history
      const key = eq < 0 ? p : p.slice(0, eq);
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new CofferError("USAGE", `not a valid name: ${key}`);
      const value = eq < 0 ? await askHidden(`value for ${key}: `) : p.slice(eq + 1);
      const e = entries.find((x) => x.key === key);
      if (e) e.value = value; else entries.push({ key, value });
    }
  }
  const g = await writeValues(f, id, entries);
  writeSealed(path, g);
  say(`${c.green(unset ? "removed" : "set")} ${pos.map((p) => p.split("=")[0]).join(", ")} in ${path} ${c.dim(`(version ${g.version})`)}`);
}

async function keys(flags: Record<string, string | true>) {
  const path = resolveSealed(flags);
  const f = readSealed(path);
  await checkFile(f, { offline: flags.offline === true, path, acceptOwner: flags["accept-owner"] === true });
  for (const e of await entriesOf(f, loadIdentity())) say(e.key);
}

/** Files shared with this address, found on QoreChain (no repo or download needed). */
async function inbox() {
  const id = loadIdentity();
  const ids = (await filesOf(evmNet, id.address)).reverse();
  if (!ids.length) return say("nothing shared with you yet");
  for (const fid of ids) {
    const d = await readFile(evmNet, fid);
    if (!d) continue;
    const f = parseCoffer(d.text);
    const from = d.owner === id.address ? "you" : d.owner;
    say(`${fid}  ${c.bold(d.name)}  from ${from}  ${f.readers.includes(id.address) ? c.green("you can open it") : c.red("you were removed")}`);
  }
  say(c.dim(`  coffer pull <id> [-f .env.coffer] saves the latest copy; then coffer run -- <command>`));
}

/** Save the latest sealed copy of a file from QoreChain, after the same checks as opening it. */
async function pull(pos: string[], flags: Record<string, string | true>) {
  const fid = pos[0];
  if (!fid || !/^[0-9a-f]{32}$/.test(fid)) throw new CofferError("USAGE", "usage: coffer pull <file id> [-f .env.coffer]   (coffer inbox lists the ids)");
  const d = await readFile(evmNet, fid);
  if (!d) throw new CofferError("NO_FILE", `QoreChain has no file ${fid}`);
  const path = resolveSealed(flags);
  const f = parseCoffer(d.text);
  const me = loadIdentity().address;
  if (!f.readers.includes(me)) throw new CofferError("NOT_A_READER", `you were removed from ${d.name}: its latest version is not sealed to you, so there is nothing for you to open`);
  await checkFile(f, { path, acceptOwner: flags["accept-owner"] === true });
  writeSealed(path, f);
  say(`${c.green("pulled")} ${d.name} (epoch ${d.epoch}, version ${d.version}) from QoreChain into ${path}`);
}

async function status(flags: Record<string, string | true>) {
  const path = resolveSealed(flags);
  const f = readSealed(path);
  say(`${c.bold(path)}  ${c.dim(`file ${f.id} · ${f.chainId}`)}`);
  const known = pins()[resolve(path)];
  say(`  owner    ${f.owner}${known && known !== f.owner ? c.red(`  (CHANGED: this machine knew ${known})`) : ""}`);
  say(`  epoch    ${f.epoch}   version ${f.version}   last written by ${f.writer === f.owner ? "owner" : f.writer}`);
  say(`  readers  ${f.readers.length}`);
  for (const r of f.readers) say(`    ${r}${r === f.owner ? c.dim("  (owner)") : ""}`);
  try {
    await checkFile(f);
    say(`  ${c.green("signatures verify")} against ML-DSA-87 keys on QoreChain; not older than the chain record`);
  } catch (e) {
    say(`  ${c.red("CHECK FAILED")}: ${(e as Error).message}`);
  }
  const head = await readHead(evmNet, f.id);
  if (!head) say(`  on QoreChain: ${c.red("not recorded")}`);
  else say(`  on QoreChain: epoch ${head.epoch}, version ${head.version}, owner ${head.owner}, recorded at block ${head.height} ${c.dim(`(contract ${evmNet.coffer})`)}`);
  const opens = head ? await readOpens(evmNet, f.id) : [];
  say(`  opened through QoreChain: ${opens.length} time${opens.length === 1 ? "" : "s"}`);
  for (const o of opens.slice(-8)) say(c.dim(`    ${o.reader}  epoch ${o.epoch}  version ${o.version}  block ${o.block}`));
}

function askHidden(prompt: string): Promise<string> {
  return new Promise((ok) => {
    const tty = !!process.stdin.isTTY;
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
    if (tty) {
      process.stdout.write(prompt);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    }
    rl.question(tty ? "" : prompt, (v) => {
      rl.close();
      if (tty) process.stdout.write("\n");
      ok(v);
    });
  });
}

/** Re-send the chain record for the file's current epoch if it is missing. Owner only. */
async function recordCmd(flags: Record<string, string | true>) {
  const path = resolveSealed(flags);
  const f = readSealed(path);
  const id = loadIdentity();
  if (id.address !== f.owner) throw new CofferError("NOT_OWNER", "only the owner records changes to this file");
  verifyCoffer(f, await fetchPqKeys(net, [f.owner, f.writer]));
  const head = await readHead(evmNet, f.id);
  if (head && head.epoch >= f.epoch) return say(`epoch ${f.epoch} is already recorded on chain`);
  await recordHead(f);
}

const HELP = `coffer: push your secrets to GitHub. Only your team can open them.

  coffer init                      make your identity and publish your card on QoreChain
  coffer whoami                    your address and key status
  coffer lock [.env] [--to qor1..] seal .env into .env.coffer (safe to commit)
  coffer import [.env] [--keys .env.keys]   move a dotenvx file to Coffer
  coffer run [-f file] -- <cmd>    run a command with the secrets in its environment only
  coffer share <qor1...>           add readers (new epoch, recorded on chain)
  coffer revoke <qor1...>          remove readers and list the keys to rotate
  coffer set KEY | unset KEY       change a value (it asks for it); nothing plain on disk
  coffer record                    re-send the chain record for the current epoch (owner)
  coffer keys                      list the names in the file
  coffer status                    readers, epoch, signature check, the record on chain
  coffer inbox                     files shared with you, found on QoreChain
  coffer pull <id>                 save the latest copy of a shared file from QoreChain

  -f, --file <path>   sealed file (default .env.coffer)
  --accept-owner      trust a file whose owner changed since this machine last saw it
  COFFER_IDENTITY     recovery phrase, for servers and CI (instead of ~/.coffer/identity)
`;

async function main() {
  const { cmd, pos, flags, rest } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "init": return init();
    case "whoami": return whoami();
    case "lock": return lock(pos, flags);
    case "import": return importCmd(pos, flags);
    case "run": return run(flags, rest);
    case "share": return share(pos, flags);
    case "revoke": return revoke(pos, flags);
    case "set": return setCmd(pos, flags);
    case "unset": return setCmd(pos, flags, true);
    case "keys": return keys(flags);
    case "status": return status(flags);
    case "inbox": return inbox();
    case "pull": return pull(pos, flags);
    case "record": return recordCmd(flags);
    default: process.stdout.write(HELP);
  }
}

main().catch((e) => {
  console.error(c.red(`coffer: ${e instanceof Error ? e.message : String(e)}`));
  // exitCode, not exit(): exiting while fetch sockets close crashes libuv on Windows
  process.exitCode = 1;
});
