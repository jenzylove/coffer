// /app: create an address, then a dashboard of the files sealed in this browser.
// Each change is recorded on QoreChain before the file is saved (as in the CLI).
// The selected file is shown as the document: names with black bars, the To list,
// and the proof with the demo teammate. Raw data stays behind "Details".
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Page } from "../components/Chrome.tsx";
import { Bar, Sheet, Stamp } from "../components/Doc.tsx";
import { IdentityProvider, useIdentity, isReady } from "../lib/identity.tsx";
import { api, download, qor, short } from "../lib/net.ts";
import { SETUP_UQOR, dripAndWait, record, remember } from "../lib/ops.ts";
import { work } from "../lib/crypto.ts";
import { parseCoffer, type CofferFile } from "../../../src/core/vault.ts";
import { parseDotenv, serializeDotenv, type DotenvEntry } from "../../../src/core/dotenv.ts";
import type { Grant, GrantRecord } from "../../../src/chain/qore.ts";
import { fetchReader, grantHistory, registerIdentity } from "../lib/chain.ts";
import { IMPORT_KEY, type ImportHint } from "../landing/ScanDoor.tsx";
import { Addr, Chips, DropText, Log, Problem, Progress, Result, TxLink, type LogLine } from "./bits.tsx";
import { OpenFile } from "./OpenFile.tsx";

// ---- files kept in this browser (sealed text only: safe to store) ------------

interface Stored { text: string; old?: string; tx?: string; changed: string; note?: string; removed?: string[] }
const FILES = "coffer.files";
function loadFiles(): Stored[] {
  try {
    const list = JSON.parse(localStorage.getItem(FILES) ?? "null") as Stored[] | null;
    if (list) return list;
    const one = localStorage.getItem("coffer.file"); // earlier versions kept a single file
    if (one) return [{ text: one, old: localStorage.getItem("coffer.oldfile") ?? undefined, changed: new Date().toISOString() }];
  } catch { /* storage blocked */ }
  return [];
}
function saveFiles(list: Stored[]) { try { localStorage.setItem(FILES, JSON.stringify(list)); localStorage.setItem("coffer.file", list[0]?.text ?? ""); } catch { /* storage blocked */ } }
const idOf = (s: Stored) => { try { return parseCoffer(s.text).id; } catch { return ""; } };

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

function useLog() {
  const [lines, setLines] = useState<LogLine[]>([]);
  return {
    lines,
    reset: () => setLines([]),
    step: (text: string, hash?: string) => setLines((x) => [...x.map((y) => (y.state === "doing" ? { ...y, state: "done" as const } : y)), { text, hash, state: hash ? "done" : "doing" }]),
    done: (text?: string, hash?: string) => setLines((x) => [...x.map((y) => (y.state === "doing" ? { ...y, state: "done" as const } : y)), ...(text ? [{ text, hash, state: "done" as const }] : [])]),
    fail: () => setLines((x) => x.map((y) => (y.state === "doing" ? { ...y, state: "err" as const } : y))),
  };
}

export default function AppRoute() {
  return (
    <IdentityProvider>
      <Page>
        <App />
      </Page>
    </IdentityProvider>
  );
}

function App() {
  const ident = useIdentity();
  const { phrase, id, deriving, status, statusError } = ident;
  const [readyMoment, setReadyMoment] = useState(false);
  const ready = isReady(status);

  if (!phrase) return <Onboard />;
  if (deriving || !id) return <Hold title="Making your keys." line="This happens in your browser and takes a few seconds." />;
  if (!status && !statusError) return <Hold title="Checking your address." line="Reading QoreChain." />;
  if (!ready || readyMoment) return <Setup onReady={() => { setReadyMoment(true); setTimeout(() => setReadyMoment(false), 1600); }} />;
  return <Dashboard />;
}

function Hold({ title, line }: { title: string; line: string }) {
  return (
    <section className="onboard" id="address">
      <div className="wrap onboard-in">
        <h1 className="h-display h1">{title}</h1>
        <p className="lead">{line}</p>
        <span className="prog-bar" aria-hidden><span className="indeterminate" /></span>
      </div>
    </section>
  );
}

// ---- no address yet -------------------------------------------------------------

function Onboard() {
  const ident = useIdentity();
  const [paste, setPaste] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <section className="onboard" id="address">
      <div className="wrap onboard-in">
        <h1 className="h-display h1">Create your address.</h1>
        <p className="lead">It's made from a 24 word recovery phrase, right here in your browser. No wallet, no sign up.</p>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await ident.create(); } finally { setBusy(false); } }}>
            {busy ? "Making your address" : "Make a new address"}
          </button>
          <button className="link" onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen}>I have a recovery phrase</button>
        </div>
        {pasteOpen && (
          <form className="phrase-form" onSubmit={async (e) => {
            e.preventDefault(); setErr(null);
            try { await ident.restore(paste); setPaste(""); } catch (x) { setErr(x); }
          }}>
            <label htmlFor="phrase" className="label">Recovery phrase, 24 words</label>
            <textarea id="phrase" className="mono" rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} autoComplete="off" />
            <div><button className="btn-outline">Use this phrase</button></div>
            {err !== null && <Problem error={err} text="That isn't a valid 24 word recovery phrase." />}
          </form>
        )}
      </div>
    </section>
  );
}

// ---- setup: starts by itself; "Get set up" only to retry -------------------------

function Setup({ onReady }: { onReady: () => void }) {
  const ident = useIdentity();
  const { id, status } = ident;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [started, setStarted] = useState(false);
  const log = useLog();
  const ready = isReady(status);

  const setup = useCallback(async () => {
    if (!id) return;
    setStarted(true); setBusy(true); setErr(null); log.reset();
    try {
      log.step("Checking your address");
      const st = await ident.refresh();
      if (!st) throw new Error("QoreChain can't be reached right now. Try again in a moment.");
      if (st.uqor < SETUP_UQOR && !(st.mldsa && st.kemIsOurs)) {
        log.step("Paying setup");
        await dripAndWait(id, SETUP_UQOR, (_t, hash) => log.step("Setup paid by the Coffer relayer", hash));
      }
      await registerIdentity(id, (s, hash) => {
        if (hash) log.step(s.startsWith("ML-DSA") ? "Signing key registered" : "Sealing key published", hash);
        else log.step(s.startsWith("registering") ? "Registering your signing key" : "Publishing your sealing key");
      });
      log.done();
      const after = await ident.refresh();
      if (isReady(after)) onReady();
    } catch (e) {
      log.fail();
      setErr(e);
    } finally {
      setBusy(false);
    }
  }, [id, ident, log, onReady]);

  useEffect(() => { if (!started && !ready && id) void setup(); }, [started, ready, id, setup]);

  return (
    <section className="onboard" id="address">
      <div className="wrap onboard-in">
        {ready ? (
          <>
            <h1 className="h-display h1">Ready.</h1>
            <Result>Ready. Anyone can seal files to you now.</Result>
          </>
        ) : (
          <>
            <h1 className="h-display h1">{err ? "Setup stopped." : "Setting up."}</h1>
            <p className="lead">Your public keys go on QoreChain so teammates can seal files to you. The Coffer relayer pays.</p>
            {busy && <Progress lines={log.lines} />}
            {err !== null && <Problem error={err} />}
            {!busy && <div className="actions"><button className="btn" onClick={() => void setup()}>Get set up</button></div>}
            {log.lines.length > 0 && <details className="raw"><summary>Details</summary><Log lines={log.lines} /></details>}
          </>
        )}
      </div>
    </section>
  );
}

// ---- the dashboard ---------------------------------------------------------------

type View = { kind: "file"; id: string } | { kind: "seal" } | { kind: "open" };

function Dashboard() {
  const { id } = useIdentity();
  const [files, setFilesRaw] = useState<Stored[]>(loadFiles);
  const setFiles = (f: (x: Stored[]) => Stored[]) => setFilesRaw((x) => { const n = f(x); saveFiles(n); return n; });
  const mine = useMemo(() => files.filter((s) => { try { return parseCoffer(s.text).owner === id?.address; } catch { return false; } }), [files, id]);
  const [view, setView] = useState<View>(() => {
    if (location.hash === "#open") return { kind: "open" };
    if (location.hash === "#seal" || !mine.length) return { kind: "seal" };
    return { kind: "file", id: idOf(mine[0]!) };
  });
  const pick = (v: View) => { history.replaceState(null, "", v.kind === "open" ? "/app#open" : v.kind === "seal" ? "/app#seal" : "/app"); setView(v); };
  useEffect(() => {
    const on = () => { if (location.hash === "#open") setView({ kind: "open" }); else if (location.hash === "#seal") setView({ kind: "seal" }); };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  const update = (fileId: string, patch: Partial<Stored>) => setFiles((list) => list.map((s) => (idOf(s) === fileId ? { ...s, ...patch, changed: new Date().toISOString() } : s)));
  const current = view.kind === "file" ? mine.find((s) => idOf(s) === view.id) : undefined;

  return (
    <div className="dash wrap">
      <aside className="dash-left">
        <KeysBlock />
        <div className="files" role="tablist" aria-label="Your files" aria-orientation="vertical">
          <p className="label">Your files</p>
          {mine.length === 0 && <p className="muted small">None yet.</p>}
          {mine.map((s) => {
            const f = parseCoffer(s.text);
            return (
              <button key={f.id} role="tab" aria-selected={view.kind === "file" && view.id === f.id} className="file-row" onClick={() => pick({ kind: "file", id: f.id })}>
                <span className="mono file-name">{f.name}.coffer</span>
                <span className="file-meta">{f.readers.length} {f.readers.length === 1 ? "reader" : "readers"} · {ago(s.changed)}</span>
              </button>
            );
          })}
          <button role="tab" aria-selected={view.kind === "seal"} className="btn btn-block" onClick={() => pick({ kind: "seal" })}>Seal a file</button>
          <button role="tab" aria-selected={view.kind === "open"} className="file-row file-open" onClick={() => pick({ kind: "open" })}>
            <span className="file-name">Open a file</span>
            <span className="file-meta">Paste or drop a .env.coffer</span>
          </button>
        </div>
      </aside>
      <div className="dash-main">
        {view.kind === "seal" && (
          <SealPanel onSealed={(text, tx) => {
            const f = parseCoffer(text);
            setFiles((list) => [{ text, tx, changed: new Date().toISOString(), note: "Sealed. Safe to commit." }, ...list]);
            pick({ kind: "file", id: f.id });
          }} />
        )}
        {view.kind === "open" && <OpenFile />}
        {view.kind === "file" && current && <FileDetail stored={current} onChange={(patch) => update(idOf(current), patch)} />}
        {view.kind === "file" && !current && <p className="muted">That file isn't in this browser any more.</p>}
      </div>
    </div>
  );
}

function KeysBlock() {
  const ident = useIdentity();
  const { id, phrase, status } = ident;
  const [show, setShow] = useState(false);
  if (!id) return null;
  return (
    <section className="keys" id="address">
      <p className="label">Your keys</p>
      <Result>Ready. Anyone can seal files to you now.</Result>
      <div className="acts">
        <button className="link" onClick={() => setShow((v) => !v)} aria-expanded={show}>{show ? "Hide recovery phrase" : "Show recovery phrase"}</button>
        <button className="link" onClick={() => download("coffer-recovery-phrase.txt", `Coffer recovery phrase for ${id.address}\nIt opens every Coffer file shared with this address. Keep it private.\n\n${phrase}\n`)}>Download</button>
      </div>
      <p className="muted small">Your recovery phrase opens everything shared with you. Keep it private.</p>
      {show && <p className="phrase mono">{phrase}</p>}
      <details className="raw">
        <summary>Details</summary>
        <dl className="facts">
          <div><dt>Full address</dt><dd className="mono">{id.address}</dd></div>
          {status && <div><dt>Balance</dt><dd className="mono">{qor(status.uqor)} test QOR</dd></div>}
          {status && <div><dt>Signing key (ML-DSA-87)</dt><dd>{status.mldsa ? "Registered" : "Not yet"}</dd></div>}
          {status && <div><dt>Sealing key (ML-KEM-1024)</dt><dd>{status.kemIsOurs ? "Published" : "Not yet"}</dd></div>}
        </dl>
        <button className="link" onClick={() => { if (confirm("Remove this address from this browser? Without the recovery phrase you can't open files shared with it.")) ident.forget(); }}>Remove this address from this browser</button>
      </details>
    </section>
  );
}

// ---- seal a file ------------------------------------------------------------------

function readHint(): ImportHint | null {
  try { const t = sessionStorage.getItem(IMPORT_KEY); return t ? JSON.parse(t) : null; } catch { return null; }
}

function SealPanel({ onSealed }: { onSealed: (text: string, tx?: string) => void }) {
  const { id } = useIdentity();
  const [hint, setHint] = useState<ImportHint | null>(readHint);
  const [tab, setTab] = useState<"plain" | "dotenvx">(hint?.kind === "dotenvx" ? "dotenvx" : "plain");
  const [env, setEnv] = useState("");
  const [keys, setKeys] = useState("");
  const [hintErr, setHintErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const log = useLog();
  const name = hint ? hint.path.split("/").pop() || ".env" : ".env";
  // the dotenvx reader (secp256k1 + ECIES) loads only when a dotenvx file is in play
  const [dx, setDx] = useState<typeof import("../../../src/core/dotenvx.ts") | null>(null);
  const needsDx = tab === "dotenvx" || /DOTENV_PUBLIC_KEY|encrypted:/.test(env);
  useEffect(() => { if (needsDx && !dx) import("../../../src/core/dotenvx.ts").then(setDx).catch(() => {}); }, [needsDx, dx]);

  useEffect(() => {
    if (!hint) return;
    const url = `https://raw.githubusercontent.com/${hint.repo}/${encodeURIComponent(hint.branch)}/${hint.path.split("/").map(encodeURIComponent).join("/")}`;
    fetch(url).then(async (r) => { if (!r.ok) throw new Error(String(r.status)); setEnv(await r.text()); setHintErr(false); }).catch(() => setHintErr(true));
  }, [hint]);

  const preview = useMemo((): { entries: DotenvEntry[] | null; note: string | null } => {
    if (!env.trim()) return { entries: null, note: null };
    if (needsDx && !dx) return { entries: null, note: "Reading the file…" };
    const scan = dx ? dx.scanDotenvx(env) : { isDotenvx: false, encryptedKeys: [] as string[] };
    if (tab === "plain") {
      if (scan.isDotenvx) return { entries: null, note: "This file is locked by dotenvx. Switch to \"Move from dotenvx\" to bring its values over." };
      const e = parseDotenv(env);
      return { entries: e, note: e.length ? null : "No NAME=value lines found." };
    }
    if (!scan.isDotenvx) return { entries: null, note: "This file isn't locked by dotenvx. Use \"Paste a .env\" instead." };
    if (!keys.trim()) return { entries: null, note: `${scan.encryptedKeys.length} locked values found. Add the matching .env.keys to unlock them here.` };
    try { return { entries: dx!.importDotenvx(env, keys).entries, note: null }; }
    catch { return { entries: null, note: "That .env.keys doesn't match this file." }; }
  }, [env, keys, tab, dx, needsDx]);

  async function seal() {
    if (!id || !preview.entries?.length) return;
    setBusy(true); setErr(null); log.reset();
    try {
      log.step("Sealing in your browser");
      const text = await work<string>("create", { name, owner: id, env: serializeDotenv(preview.entries) });
      const f = parseCoffer(text);
      const grant: Grant = { op: "create", fileId: f.id, epoch: f.epoch, version: f.version, added: [], removed: [] };
      log.step("Recording it on QoreChain");
      const txs = await record(id, grant, (_t, hash) => log.step("Fee topped up by the relayer", hash));
      log.done("Recorded on QoreChain", txs[0]?.hash);
      setEnv(""); setKeys("");
      try { sessionStorage.removeItem(IMPORT_KEY); } catch { /* storage blocked */ }
      remember(f);
      onSealed(text, txs[0]?.hash);
    } catch (e) {
      log.fail();
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" id="seal" aria-labelledby="h-seal">
      <h2 id="h-seal" className="h-section">Seal a file.</h2>
      {hint && (
        <div className="hintline">
          <p>Moving <span className="mono">{hint.path}</span> from <span className="mono">{hint.repo}</span>.{" "}
            {hint.kind === "plain" ? "It's public right now, so change these values at each provider after sealing the new ones." :
              hint.kind === "dotenvx" ? "We filled in the file from GitHub. Add your .env.keys below; it never leaves this page." : ""}</p>
          <button className="link" onClick={() => { try { sessionStorage.removeItem(IMPORT_KEY); } catch { /* */ } setHint(null); setEnv(""); }}>Clear</button>
        </div>
      )}
      {hintErr && <Problem text={`Couldn't fetch ${hint?.path ?? "the file"} from GitHub. Paste it below instead.`} />}
      <div className="seg" role="tablist" aria-label="Source">
        <button role="tab" aria-selected={tab === "plain"} onClick={() => setTab("plain")}>Paste a .env</button>
        <button role="tab" aria-selected={tab === "dotenvx"} onClick={() => setTab("dotenvx")}>Move from dotenvx</button>
      </div>
      <DropText id="envtext" label={tab === "plain" ? "Your .env" : "Your dotenvx .env"} value={env} onChange={setEnv} placeholder={"NAME=value\nOTHER_NAME=value"} />
      {tab === "dotenvx" && (
        <>
          <DropText id="keystext" label="Its .env.keys" value={keys} onChange={setKeys} rows={3} placeholder="DOTENV_PRIVATE_KEY=…" />
          <p className="muted small">Unlocked here in your browser. Nothing is sent anywhere.</p>
        </>
      )}
      {preview.note && <p className="muted">{preview.note}</p>}
      {preview.entries && preview.entries.length > 0 && (
        <div><p className="label">{preview.entries.length} {preview.entries.length === 1 ? "value" : "values"} to seal</p><Chips names={preview.entries.map((e) => e.key)} /></div>
      )}
      <div><button className="btn" disabled={busy || !preview.entries?.length} onClick={seal}>{busy ? "Sealing" : `Seal into ${name}.coffer`}</button></div>
      <Progress lines={log.lines} />
      {err !== null && <Problem error={err} />}
      <p className="muted small">Values stay in this page's memory only. They are never saved in this browser.</p>
    </section>
  );
}

// ---- one file, as the document -------------------------------------------------------

type TeammateAnswer = { opened: true; keys: string[]; epoch: number | string; version: number | string; verified: boolean } | { opened: false; code?: string; error: string };
type Outcome = { kind: "ask"; answer: TeammateAnswer; label: string } | { kind: "revoke"; rotate: string[]; who: string; tx?: string };

const REFUSED: Record<string, string> = {
  NOT_A_READER: "They're not on the list any more.",
  ROLLBACK: "This is an old copy. A newer version exists.",
  BAD_SIGNATURE: "Someone changed this file by hand.",
  UNRECORDED: "QoreChain has no record of this version.",
};

async function getTeammate(): Promise<string> {
  const r = await api<{ address: string }>("/api/teammate");
  if (!r.address) throw new Error("The demo teammate isn't available right now.");
  return r.address;
}

/** The owner's view of the values: names with bars; click a bar to see that one value, it closes again on blur. */
function Values({ text }: { text: string }) {
  const { id } = useIdentity();
  const [entries, setEntries] = useState<DotenvEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (id) work<DotenvEntry[]>("open", { text, keys: id.sealKeys }).then((e) => live && setEntries(e)).catch(() => live && setEntries([]));
    return () => { live = false; };
  }, [text, id]);
  if (!entries) return <p className="sheet-wait">Opening with your keys…</p>;
  return (
    <div className="doc-values">
      {entries.map((e) => (
        <div key={e.key} className="env-line">
          <span className="env-k">{e.key}=</span>
          <button className="reveal-bar" onClick={() => setOpen(e.key)} onBlur={() => setOpen((o) => (o === e.key ? null : o))} aria-label={open === e.key ? `${e.key}, shown` : `Show ${e.key}`}>
            {open === e.key ? <span className="mono">{e.value || "(empty)"}</span> : <Bar w={Math.min(22, Math.max(8, Math.round(e.value.length * 0.6)))} />}
          </button>
        </div>
      ))}
      <p className="sheet-note">Click a bar to see that value. It closes when you click away.</p>
    </div>
  );
}

function FileDetail({ stored, onChange }: { stored: Stored; onChange: (patch: Partial<Stored>) => void }) {
  const { id } = useIdentity();
  const file = useMemo(() => parseCoffer(stored.text), [stored.text]);
  const [teammate, setTeammate] = useState<string | null>(null);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const log = useLog();

  useEffect(() => { getTeammate().then(setTeammate).catch(() => {}); }, []);
  useEffect(() => { setOutcomes([]); setErr(null); log.reset(); }, [file.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = (a: string) => (a === id?.address ? "You" : a === teammate ? "Demo teammate" : short(a, 6, 4));
  const mateIn = !!teammate && file.readers.includes(teammate);
  const mateRevoked = !!teammate && !mateIn && !!stored.old;

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key); setErr(null);
    try { await fn(); } catch (e) { log.fail(); setErr(e); } finally { setBusy(null); }
  }

  const share = (address: string) => act(address === teammate ? "teammate" : "share", async () => {
    if (!id) return;
    log.reset();
    if (file.readers.includes(address)) throw new Error("They can already read this file.");
    log.step("Finding their key on QoreChain");
    const reader = await fetchReader(address);
    log.step("Sealing a new key to them");
    const text = await work<string>("share", { text: stored.text, owner: id, readers: [reader] });
    const g = parseCoffer(text);
    log.step("Recording the share on QoreChain");
    const txs = await record(id, { op: "share", fileId: g.id, epoch: g.epoch, version: g.version, added: [address], removed: [] }, (_t, h) => log.step("Fee topped up by the relayer", h));
    log.done("Share recorded", txs[0]?.hash);
    remember(g);
    onChange({ text, note: `Shared with ${address === teammate ? "the demo teammate" : short(address, 6, 4)}.`, removed: (stored.removed ?? []).filter((a) => a !== address) });
    setAddr("");
  });

  const revoke = (address: string) => act(address === teammate ? "revoke" : `remove-${address}`, async () => {
    if (!id) return;
    log.reset();
    log.step("Sealing the file again with a new key");
    const r = await work<{ text: string; rotate: string[] }>("revoke", { text: stored.text, owner: id, addresses: [address] });
    const g = parseCoffer(r.text);
    log.step("Recording the revoke on QoreChain");
    const txs = await record(id, { op: "revoke", fileId: g.id, epoch: g.epoch, version: g.version, added: [], removed: [address] }, (_t, h) => log.step("Fee topped up by the relayer", h));
    log.done("Revoke recorded", txs[0]?.hash);
    remember(g);
    onChange({ text: r.text, old: stored.text, note: `Revoked. Rotate these ${r.rotate.length} keys.`, removed: [...new Set([...(stored.removed ?? []), address])] });
    setOutcomes((o) => [...o, { kind: "revoke", rotate: r.rotate, who: name(address), tx: txs[0]?.hash }]);
  });

  const ask = (text: string, label: string) => act(label, async () => {
    const answer = await api<TeammateAnswer>("/api/teammate/open", { body: { file: text } });
    setOutcomes((o) => [...o, { kind: "ask", answer, label }]);
  });

  const readers = [...file.readers].sort((a, b) => (a === file.owner ? -1 : b === file.owner ? 1 : 0));
  const removed = (stored.removed ?? []).filter((a) => !file.readers.includes(a));

  return (
    <div className="file">
      <section id="seal" aria-labelledby="h-file">
        <Sheet
          className="sheet-file"
          left={<span id="h-file">{file.name}.coffer</span>}
          right={`readers: ${file.readers.length}`}
          stamp={<Stamp>Sealed</Stamp>}
        >
          <Values text={stored.text} />
        </Sheet>
        <div className="file-status">
          <Result>{stored.note ?? "Sealed. Safe to commit."}</Result>
          <button className="link" onClick={() => download(`${file.name}.coffer`, stored.text)}>Download {file.name}.coffer</button>
        </div>
        <details className="raw">
          <summary>Details</summary>
          <dl className="facts">
            <div><dt>File id</dt><dd className="mono">{file.id}</dd></div>
            <div><dt>Epoch</dt><dd className="mono">{String(file.epoch)}</dd></div>
            <div><dt>Version</dt><dd className="mono">{String(file.version)}</dd></div>
            {stored.tx && <div><dt>First record</dt><dd><TxLink hash={stored.tx} /></dd></div>}
          </dl>
          <Log lines={log.lines} />
          <Records file={file} name={name} />
          <pre className="mono">{stored.text}</pre>
        </details>
      </section>

      <section className="file-sec" id="share" aria-labelledby="h-to">
        <h3 id="h-to" className="label">To</h3>
        <ul className="to-list">
          {readers.map((a) => (
            <li key={a}>
              <span className="to-name">{a === file.owner ? "You, owner" : name(a)}</span>
              <Addr a={a} />
              {a !== file.owner ? <button className="link" disabled={!!busy} onClick={() => void revoke(a)}>{busy === `remove-${a}` ? "Removing" : "Remove"}</button> : <span />}
            </li>
          ))}
          {removed.map((a) => (
            <li key={a} className="to-removed">
              <span className="to-name struck">{name(a)}</span>
              <span className="mono struck">{short(a, 8, 4)}</span>
              <span className="no small">removed</span>
            </li>
          ))}
        </ul>
        <form className="line-form" onSubmit={(e) => { e.preventDefault(); const a = addr.trim(); if (a) void share(a); }}>
          <label htmlFor="addr" className="sr">Add someone by address</label>
          <input id="addr" className="mono" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Add someone by address: qor1…" spellCheck={false} autoComplete="off" />
          <button className="btn" disabled={!!busy || !addr.trim()}>{busy === "share" ? "Sharing" : "Share"}</button>
        </form>
        <div className="mate-row">
          <button className="btn-outline" disabled={!!busy || mateIn} onClick={async () => {
            // never wait on the button: fetch the teammate's address on click if it hasn't arrived yet
            try { const a = teammate ?? await getTeammate(); setTeammate(a); void share(a); } catch (e) { setErr(e); }
          }}>
            {busy === "teammate" ? "Sharing with the demo teammate" : mateIn ? "Demo teammate added" : "Add the demo teammate"}
          </button>
          <span className="muted small">A test teammate run by Coffer, so you can try sharing and revoking alone.</span>
        </div>
        {busy && <Progress lines={log.lines} />}
        {err !== null && <Problem error={err} />}
      </section>

      <section className="file-sec" id="prove" aria-labelledby="h-prove">
        <h3 id="h-prove" className="label">Prove it</h3>
        <p className="muted">The demo teammate is a separate person on the Coffer server. They check the file against QoreChain like the CLI does, and report only the names they could read.</p>
        <div className="prove-acts">
          <button className="btn-outline" disabled={!!busy || !mateIn} onClick={() => void ask(stored.text, "first")}>{busy === "first" ? "Asking" : "Ask the teammate"}</button>
          <button className="btn-outline" disabled={!!busy || !mateIn} onClick={() => teammate && void revoke(teammate)}>{busy === "revoke" ? "Revoking" : "Revoke"}</button>
          <button className="btn-outline" disabled={!!busy || !mateRevoked} onClick={() => void ask(stored.text, "again")}>{busy === "again" ? "Asking" : "Ask the teammate again"}</button>
          <button className="btn-outline" disabled={!!busy || !mateRevoked} onClick={() => stored.old && void ask(stored.old, "old")}>{busy === "old" ? "Asking" : "Send the old copy to the teammate"}</button>
        </div>
        {!mateIn && !mateRevoked && <p className="muted small">Add the demo teammate above to start.</p>}
        <div className="outcomes">
          {outcomes.map((o, i) => <OutcomeView key={i} o={o} />)}
        </div>
      </section>
    </div>
  );
}

function OutcomeView({ o }: { o: Outcome }) {
  if (o.kind === "revoke") {
    return (
      <div className="outcome rotate">
        <Stamp tone="ink">Revoked</Stamp>
        <p>{o.who} can't read the new file. Rotate these {o.rotate.length} keys: they may have read them before.</p>
        <Chips names={o.rotate} />
        {o.tx && <details className="steps"><summary>Details</summary><p>Recorded on QoreChain: <TxLink hash={o.tx} /></p></details>}
      </div>
    );
  }
  const a = o.answer;
  const what = o.label === "old" ? "The old copy, sent to the teammate" : o.label === "again" ? "Asked again" : "Asked the teammate";
  return a.opened ? (
    <div className="outcome answer">
      <p className="label">{what}</p>
      <Stamp>Opened</Stamp>
      <p>They read {a.keys.length} {a.keys.length === 1 ? "name" : "names"}. The server reports names only, never values.</p>
      <Chips names={a.keys} />
      <details className="steps"><summary>Details</summary><p className="mono">epoch {String(a.epoch)} · version {String(a.version)} · signatures checked on QoreChain</p></details>
    </div>
  ) : (
    <div className="outcome answer">
      <p className="label">{what}</p>
      <Stamp tone="red">Refused</Stamp>
      <p>{(a.code && REFUSED[a.code]) ?? a.error}</p>
      <details className="steps"><summary>Details</summary><p className="mono">{a.code ? `${a.code}: ` : ""}{a.error}</p></details>
    </div>
  );
}

function Records({ file, name }: { file: CofferFile; name: (a: string) => string }): ReactNode {
  const [hist, setHist] = useState<GrantRecord[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { setHist(null); grantHistory(file.owner, file.id).then(setHist).catch(() => setErr(true)); }, [file.owner, file.id, file.epoch]);
  const OP: Record<string, string> = { create: "Sealed", share: "Shared", revoke: "Revoked" };
  if (err) return <p className="muted small">QoreChain can't be reached right now.</p>;
  if (!hist) return <p className="muted small">Reading the records…</p>;
  return (
    <ol className="records">
      {hist.map((h) => (
        <li key={h.hash}>
          <span>{new Date(h.time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
          <span>{OP[h.op] ?? h.op}</span>
          <span>{[...h.added.map((a) => `added ${name(a)}`), ...h.removed.map((a) => `removed ${name(a)}`)].join(", ")}</span>
          <TxLink hash={h.hash} label="view" />
        </li>
      ))}
    </ol>
  );
}
