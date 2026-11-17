#!/usr/bin/env node
// coffer: .env files sealed to QoreChain addresses.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import { identityFromMnemonic, newMnemonic, type Identity } from "../core/identity.ts";
import {
  createCoffer, openCoffer, shareCoffer, revokeCoffer, updateCoffer, verifyCoffer,
  formatCoffer, parseCoffer, CofferError, type CofferFile,
} from "../core/vault.ts";
import { parseDotenv, serializeDotenv, toRecord, type DotenvEntry } from "../core/dotenv.ts";
import { importDotenvx, scanDotenvx } from "../core/dotenvx.ts";
import {
  TESTNET, accountStatus, fetchReader, fetchPqKeys, registerIdentity, MIN_UQOR, recordGrant, grantHistory,
  ChainError, type Network, type TxResult,
} from "../chain/qore.ts";

const net: Network = { ...TESTNET, rest: process.env.COFFER_REST ?? TESTNET.rest };
const HOME = process.env.COFFER_HOME ?? join(homedir(), ".coffer");
const ID_FILE = join(HOME, "identity");
const SEEN_FILE = join(HOME, "seen.json");
const RELAYER = process.env.COFFER_RELAYER ?? "https://coffer.jdollar.site/api/drip";
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

/** Signatures against chain keys, the chain's latest announced epoch, and the local high-water mark. */
async function checkFile(f: CofferFile, opts: { offline?: boolean } = {}) {
  if (opts.offline) {
    console.error(c.red("warning: --offline skips the signature and rollback checks against QoreChain"));
    return;
  }
  const keys = await fetchPqKeys(net, [f.owner, f.writer]);
  verifyCoffer(f, keys);
  const hist = await grantHistory(net, f.owner, f.id);
  const top = hist.reduce((m, g) => (g.epoch > m ? g.epoch : m), 0n);
  if (f.epoch < top) throw new CofferError("ROLLBACK", `this file is epoch ${f.epoch} but its owner announced epoch ${top} on chain: it is an old copy (someone may have restored a version a removed reader can still open)`);
  const s = seen()[f.id];
  if (s && (f.epoch < BigInt(s.epoch) || (f.epoch === BigInt(s.epoch) && f.version < BigInt(s.version)))) {
    throw new CofferError("ROLLBACK", `this machine already saw epoch ${s.epoch} version ${s.version} of this file; this copy is older (epoch ${f.epoch} version ${f.version})`);
  }
}

function entriesOf(f: CofferFile, id: Identity): DotenvEntry[] {
  return parseDotenv(dec.decode(openCoffer(f, id.sealKeys)));
}

async function ensureReady(id: Identity) {
  const st = await accountStatus(net, id.address, id.sealKeys.mlkemPublicKey);
  if (!st.mldsa || !st.kemIsOurs) throw new CofferError("NOT_REGISTERED", `your address is not set up on QoreChain yet. Run "coffer init".`);
}

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
  if (ready && st.uqor >= MIN_UQOR) { say(c.green("ready: anyone can seal files to this address")); return; }
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
  say(c.green("ready: anyone can seal files to this address"));
}

async function whoami() {
  const id = loadIdentity();
  const st = await accountStatus(net, id.address, id.sealKeys.mlkemPublicKey);
  say(id.address);
  say(c.dim(`  ${Number(st.uqor) / 1e6} QOR · ML-DSA-87 key ${st.mldsa ? "registered" : "missing"} · ML-KEM-1024 key ${st.kemIsOurs ? "published" : st.kem ? "different key on chain" : "missing"}`));
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
    const f = readSealed(sealedPath);
    await checkFile(f);
    const g = updateCoffer(f, id, id.sealKeys, enc.encode(serializeDotenv(entries)));
    writeSealed(sealedPath, g);
    say(`${c.green("sealed")} ${entries.length} values into ${sealedPath} ${c.dim(`(version ${g.version}, readers unchanged: ${g.readers.length})`)}`);
  } else {
    const to = typeof flags.to === "string" ? flags.to.split(",") : [];
    const readers = await Promise.all(to.map((a) => fetchReader(net, a.trim())));
    const f = createCoffer({ chainId: net.chainId, name: plainName(sealedPath), owner: id, ownerMlkem: id.sealKeys.mlkemPublicKey, readers, plaintext: enc.encode(serializeDotenv(entries)) });
    writeSealed(sealedPath, f);
    say(`${c.green("sealed")} ${entries.length} values into ${sealedPath}`);
    const txs = await recordGrant(net, id, { op: "create", fileId: f.id, epoch: f.epoch, version: f.version, added: readers.map((r) => r.address), removed: [] });
    txs.forEach((t) => txLine("recorded on chain", t));
  }
  say(c.dim(`  commit ${sealedPath}. You can delete ${plain} once your team has it; "coffer run" never needs it.`));
}

async function run(flags: Record<string, string | true>, rest: string[]) {
  if (!rest.length) throw new CofferError("USAGE", `usage: coffer run [-f .env.coffer] -- <command>`);
  const f = readSealed(resolveSealed(flags));
  await checkFile(f, { offline: flags.offline === true });
  const id = loadIdentity();
  const vars = toRecord(entriesOf(f, id));
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
  await checkFile(f);
  const id = loadIdentity();
  const readers = await Promise.all(pos.map((a) => fetchReader(net, a)));
  const g = shareCoffer(f, id, id.sealKeys, readers);
  writeSealed(path, g);
  say(`${c.green("shared")} ${path} with ${readers.length} reader(s); epoch ${g.epoch}`);
  const txs = await recordGrant(net, id, { op: "share", fileId: g.id, epoch: g.epoch, version: g.version, added: readers.map((r) => r.address), removed: [] });
  txs.forEach((t) => txLine("recorded on chain", t));
  say(c.dim(`  commit ${path} so they get it.`));
}

async function revoke(pos: string[], flags: Record<string, string | true>) {
  if (!pos.length) throw new CofferError("USAGE", "usage: coffer revoke <qor1 address>... [-f .env.coffer]");
  const path = resolveSealed(flags);
  const f = readSealed(path);
  await checkFile(f);
  const id = loadIdentity();
  const { file, rotate } = revokeCoffer(f, id, id.sealKeys, pos, (p) => parseDotenv(dec.decode(p)).map((e) => e.key));
  writeSealed(path, file);
  say(`${c.green("revoked")} ${pos.length} reader(s); epoch ${file.epoch}. They cannot open this or any later version.`);
  const txs = await recordGrant(net, id, { op: "revoke", fileId: file.id, epoch: file.epoch, version: file.version, added: [], removed: pos });
  txs.forEach((t) => txLine("recorded on chain", t));
  say();
  say(c.bold("They may still have the values they already read. Rotate these at the provider:"));
  for (const k of rotate) say(`  ${k}`);
  say(c.dim(`  then: coffer set KEY=newvalue -f ${path}`));
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
  const readers = await Promise.all(to.map((a) => fetchReader(net, a.trim())));
  const f = createCoffer({ chainId: net.chainId, name: plainName(sealedPath), owner: id, ownerMlkem: id.sealKeys.mlkemPublicKey, readers, plaintext: enc.encode(serializeDotenv(imp.entries)) });
  writeSealed(sealedPath, f);
  say(`${c.green("moved")} ${imp.entries.length} values from dotenvx (secp256k1) to ${sealedPath} (ML-KEM-1024)`);
  const txs = await recordGrant(net, id, { op: "create", fileId: f.id, epoch: f.epoch, version: f.version, added: readers.map((r) => r.address), removed: [] });
  txs.forEach((t) => txLine("recorded on chain", t));
  say(c.dim(`  the dotenvx copy in your git history stays readable to anyone with ${keysPath}, and to a quantum computer later. Rotate these values when you can.`));
}

async function setCmd(pos: string[], flags: Record<string, string | true>, unset = false) {
  if (!pos.length) throw new CofferError("USAGE", unset ? "usage: coffer unset KEY..." : "usage: coffer set KEY=value...");
  const path = resolveSealed(flags);
  const f = readSealed(path);
  await checkFile(f);
  const id = loadIdentity();
  const entries = entriesOf(f, id);
  for (const p of pos) {
    if (unset) {
      const i = entries.findIndex((e) => e.key === p);
      if (i < 0) throw new CofferError("NO_KEY", `${p} is not in ${path}`);
      entries.splice(i, 1);
    } else {
      const eq = p.indexOf("=");
      if (eq < 1) throw new CofferError("USAGE", `expected KEY=value, got ${p.split("=")[0]}`);
      const key = p.slice(0, eq), value = p.slice(eq + 1);
      const e = entries.find((x) => x.key === key);
      if (e) e.value = value; else entries.push({ key, value });
    }
  }
  const g = updateCoffer(f, id, id.sealKeys, enc.encode(serializeDotenv(entries)));
  writeSealed(path, g);
  say(`${c.green(unset ? "removed" : "set")} ${pos.map((p) => p.split("=")[0]).join(", ")} in ${path} ${c.dim(`(version ${g.version})`)}`);
}

async function keys(flags: Record<string, string | true>) {
  const f = readSealed(resolveSealed(flags));
  await checkFile(f, { offline: flags.offline === true });
  for (const e of entriesOf(f, loadIdentity())) say(e.key);
}

async function status(flags: Record<string, string | true>) {
  const path = resolveSealed(flags);
  const f = readSealed(path);
  say(`${c.bold(path)}  ${c.dim(`file ${f.id} · ${f.chainId}`)}`);
  say(`  owner    ${f.owner}`);
  say(`  epoch    ${f.epoch}   version ${f.version}   last written by ${f.writer === f.owner ? "owner" : f.writer}`);
  say(`  readers  ${f.readers.length}`);
  for (const r of f.readers) say(`    ${r}${r === f.owner ? c.dim("  (owner)") : ""}`);
  try {
    await checkFile(f);
    say(`  ${c.green("signatures verify")} against ML-DSA-87 keys on QoreChain; not older than the chain record`);
  } catch (e) {
    say(`  ${c.red("CHECK FAILED")}: ${(e as Error).message}`);
  }
  const hist = await grantHistory(net, f.owner, f.id);
  say(`  history on chain (${hist.length})`);
  for (const h of hist) {
    const who = [...h.added.map((a) => `+${a}`), ...h.removed.map((a) => `-${a}`)].join(" ");
    say(`    ${h.time.slice(0, 16).replace("T", " ")}  ${h.op.padEnd(6)} epoch ${h.epoch}  ${who}`);
    say(c.dim(`      ${net.explorerTx?.(h.hash) ?? h.hash}`));
  }
}

const HELP = `coffer: push your secrets to GitHub. Only your team can open them.

  coffer init                      make your identity and publish your keys on QoreChain
  coffer whoami                    your address and key status
  coffer lock [.env] [--to qor1..] seal .env into .env.coffer (safe to commit)
  coffer import [.env] [--keys .env.keys]   move a dotenvx file to Coffer
  coffer run [-f file] -- <cmd>    run a command with the secrets in its environment only
  coffer share <qor1...>           add readers (new epoch, recorded on chain)
  coffer revoke <qor1...>          remove readers and list the keys to rotate
  coffer set KEY=value | unset KEY change values without writing plain text to disk
  coffer keys                      list the names in the file
  coffer status                    readers, epoch, signature check, on-chain history

  -f, --file <path>   sealed file (default .env.coffer)
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
    default: process.stdout.write(HELP);
  }
}

main().catch((e) => {
  console.error(c.red(`coffer: ${e instanceof Error ? e.message : String(e)}`));
  // exitCode, not exit(): exiting while fetch sockets close crashes libuv on Windows
  process.exitCode = 1;
});
