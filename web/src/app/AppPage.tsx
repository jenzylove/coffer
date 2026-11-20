// /app: the guided flow (address, seal, share, prove) and the "open a file" mode.
// Each step ends in one plain sentence; addresses, hashes, codes and logs are behind "Details".
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Page } from "../components/Chrome.tsx";
import { useIdentity, isReady } from "../lib/identity.tsx";
import { api, download, errText, net, qor, short } from "../lib/net.ts";
import { SETUP_UQOR, dripAndWait, record, remember } from "../lib/ops.ts";
import { work } from "../lib/crypto.ts";
import { parseCoffer, type CofferFile } from "../../../src/core/vault.ts";
import { parseDotenv, serializeDotenv, type DotenvEntry } from "../../../src/core/dotenv.ts";
import { importDotenvx, scanDotenvx } from "../../../src/core/dotenvx.ts";
import { fetchReader, registerIdentity, type Grant } from "../../../src/chain/qore.ts";
import { IMPORT_KEY, type ImportHint } from "../landing/ScanDoor.tsx";
import { Addr, Chips, DropText, Log, Problem, Progress, Result, Step, TxLink, type LogLine } from "./bits.tsx";
import { FileView, OpenFile } from "./OpenFile.tsx";

const FILE_KEY = "coffer.file";
const OLD_KEY = "coffer.oldfile";
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

type TeammateAnswer = { opened: true; keys: string[]; epoch: number | string; version: number | string; verified: boolean } | { opened: false; code?: string; error: string };
type Pending = { grant: Grant; label: string } | null;

/** A hook for a step's progress log: add a line, finish, fail. */
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

export default function AppPage() {
  const [mode, setMode] = useState<"flow" | "open">(() => (location.hash === "#open" ? "open" : "flow"));
  useEffect(() => {
    const on = () => setMode(location.hash === "#open" ? "open" : "flow");
    window.addEventListener("hashchange", on);
    window.addEventListener("popstate", on);
    return () => { window.removeEventListener("hashchange", on); window.removeEventListener("popstate", on); };
  }, []);
  const pick = (m: "flow" | "open") => { history.replaceState(null, "", m === "open" ? "/app#open" : "/app"); setMode(m); };

  return (
    <Page>
      <div className="wrap app">
        <div className="app-head">
          <div>
            <p className="eyebrow">Coffer app · QoreChain testnet</p>
            <h1 className="display app-title">{mode === "flow" ? "Seal a file, share it, take it back." : "Open a sealed file."}</h1>
          </div>
          <div className="seg" role="tablist" aria-label="Mode">
            <button role="tab" aria-selected={mode === "flow"} onClick={() => pick("flow")}>Seal and share</button>
            <button role="tab" aria-selected={mode === "open"} onClick={() => pick("open")}>Open a file</button>
          </div>
        </div>
        {mode === "flow" ? <Flow /> : <OpenFile />}
      </div>
    </Page>
  );
}

function Flow() {
  const { id, status } = useIdentity();
  const ready = isReady(status);
  const [fileText, setFileTextRaw] = useState<string | null>(() => store.get(FILE_KEY));
  const [oldText, setOldTextRaw] = useState<string | null>(() => store.get(OLD_KEY));
  const setFileText = (t: string | null) => { store.set(FILE_KEY, t); setFileTextRaw(t); };
  const setOldText = (t: string | null) => { store.set(OLD_KEY, t); setOldTextRaw(t); };
  const file = useMemo(() => { try { return fileText ? parseCoffer(fileText) : null; } catch { return null; } }, [fileText]);
  const mine = !!file && !!id && file.owner === id.address;
  const [teammate, setTeammate] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [createTx, setCreateTx] = useState<string | null>(null);

  useEffect(() => { if (file) remember(file); }, [file]);
  useEffect(() => { if (file && id && file.owner !== id.address) { setFileText(null); setOldText(null); } }, [file, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const s1 = ready ? "done" : "now";
  const s2 = !ready ? "locked" : file ? "done" : "now";
  const shared = !!file && file.readers.length > 1;
  const s3 = !file ? "locked" : shared || oldText ? "done" : "now";
  const s4 = !file || (!shared && !oldText) ? "locked" : "now";

  return (
    <div className="flow">
      <Step n={1} title="Your address" state={s1} id="address">
        <Address />
      </Step>
      <Step n={2} title="Seal a file" state={s2} id="seal">
        {s2 === "locked" ? <p className="muted">Finish setting up your address first.</p> :
          file && mine ? <Sealed file={file} text={fileText!} tx={createTx} onNew={() => { setFileText(null); setOldText(null); setPending(null); setCreateTx(null); }} /> :
            <SealForm onSealed={(t, tx) => { setFileText(t); setOldText(null); setCreateTx(tx ?? null); }} onPending={setPending} />}
      </Step>
      <Step n={3} title="Share" state={s3} id="share">
        {s3 === "locked" ? <p className="muted">Seal a file first.</p> :
          <Share file={file!} fileText={fileText!} onFile={setFileText} teammate={teammate} setTeammate={setTeammate} onPending={setPending} />}
      </Step>
      <Step n={4} title="Prove it" state={s4} id="prove">
        {s4 === "locked" ? <p className="muted">Share the file with someone first. The demo teammate is the quickest.</p> :
          <Prove file={file!} fileText={fileText!} oldText={oldText} teammate={teammate} setTeammate={setTeammate}
            onRevoked={(before, after) => { setOldText(before); setFileText(after); }} onPending={setPending} />}
      </Step>
      {pending && <PendingRecord pending={pending} onDone={() => setPending(null)} />}
    </div>
  );
}

function PendingRecord({ pending, onDone }: { pending: { grant: Grant; label: string }; onDone: () => void }) {
  const { id } = useIdentity();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="pending" role="alert">
      <p><strong>One more step: record the {pending.label} on QoreChain.</strong> Readers check that record before they open the file.</p>
      {err !== null && <Problem error={err} />}
      <button className="btn btn-seal" disabled={busy || !id} onClick={async () => {
        setBusy(true); setErr(null);
        try { await record(id!, pending.grant); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>{busy ? <><span className="spin" aria-hidden />Recording</> : "Record it on chain"}</button>
    </div>
  );
}

// ---- step 1 -------------------------------------------------------------------

function Address() {
  const ident = useIdentity();
  const { id, phrase, deriving, status, statusError, checking } = ident;
  const [showPhrase, setShowPhrase] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const log = useLog();

  if (!phrase) {
    return (
      <div className="stack">
        <p>Your address is where teammates seal files to. Coffer makes one for you, right here in your browser.</p>
        <div className="row">
          <button className="btn btn-seal" disabled={busy} onClick={async () => { setBusy(true); try { await ident.create(); } finally { setBusy(false); } }}>
            {busy ? <><span className="spin" aria-hidden />Making your address</> : "Make a new address"}
          </button>
          <button className="btn btn-line" onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen}>I have a recovery phrase</button>
        </div>
        {pasteOpen && (
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault(); setErr(null);
            try { await ident.restore(paste); setPaste(""); } catch (x) { setErr(x); }
          }}>
            <label htmlFor="phrase" className="label">Recovery phrase (24 words)</label>
            <textarea id="phrase" className="mono" rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} autoComplete="off" />
            <div><button className="btn btn-seal">Use this phrase</button></div>
            {err !== null && <Problem error={err} text="That isn't a valid 24 word recovery phrase." />}
          </form>
        )}
      </div>
    );
  }

  if (deriving || !id) return <p className="prog-line"><span className="spin" aria-hidden />Making your keys</p>;

  async function setup() {
    if (!id) return;
    setBusy(true); setErr(null); log.reset();
    try {
      log.step("Checking your address");
      const st = await ident.refresh();
      if (!st) throw new Error("QoreChain can't be reached right now. Try again in a moment.");
      if (st.uqor < SETUP_UQOR && !(st.mldsa && st.kemIsOurs)) {
        log.step("Paying setup");
        await dripAndWait(id, SETUP_UQOR, (_t, hash) => log.step("Setup paid by the Coffer relayer", hash));
      }
      await registerIdentity(net, id, (s, tx) => {
        if (tx) log.step(s.startsWith("ML-DSA") ? "Signing key registered" : "Sealing key published", tx.hash);
        else log.step(s.startsWith("registering") ? "Registering your signing key" : "Publishing your sealing key");
      });
      log.done();
      await ident.refresh();
    } catch (e) {
      log.fail();
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const ok = isReady(status);
  return (
    <div className="stack">
      <div className="addr"><Addr a={id.address} /></div>

      {ok ? <Result tone="open">Ready. Anyone can seal files to you now.</Result> :
        statusError ? <Problem text="QoreChain can't be reached right now. Try again in a moment." error={new Error(statusError)} /> :
          !status ? <p className="prog-line"><span className="spin" aria-hidden />{checking ? "Checking your address" : "Loading"}</p> : (
            <div className="stack">
              <p>One more thing: put your public keys on QoreChain so teammates can seal to you. It's free; the Coffer relayer pays.</p>
              <div><button className="btn btn-seal" disabled={busy} onClick={setup}>{busy ? <><span className="spin" aria-hidden />Setting up</> : "Get set up"}</button></div>
            </div>
          )}
      {busy && <Progress lines={log.lines} bare />}
      {err !== null && <Problem error={err} />}

      <div className="phrase-box">
        <p className="muted small">Your recovery phrase opens everything shared with you. Keep it private.</p>
        <div className="row">
          <button className="btn btn-quiet btn-sm" onClick={() => setShowPhrase((v) => !v)} aria-expanded={showPhrase}>{showPhrase ? "Hide recovery phrase" : "Show recovery phrase"}</button>
          <button className="btn btn-quiet btn-sm" onClick={() => download("coffer-recovery-phrase.txt", `Coffer recovery phrase for ${id.address}\nIt opens every Coffer file shared with this address. Keep it private.\n\n${phrase}\n`)}>Download</button>
          <button className="btn btn-quiet btn-sm" onClick={() => { if (confirm("Remove this address from this browser? Without the recovery phrase you can't open files shared with it.")) ident.forget(); }}>Remove from this browser</button>
        </div>
        {showPhrase && <p className="phrase mono">{phrase}</p>}
      </div>

      {status && (
        <details className="raw">
          <summary>Details</summary>
          <dl className="facts">
            <div><dt>Full address</dt><dd className="mono">{id.address}</dd></div>
            <div><dt>Balance</dt><dd className="mono">{qor(status.uqor)} test QOR</dd></div>
            <div><dt>Signing key (ML-DSA-87)</dt><dd>{status.mldsa ? "Registered" : "Not yet"}</dd></div>
            <div><dt>Sealing key (ML-KEM-1024)</dt><dd>{status.kemIsOurs ? "Published" : status.kem ? "A different key is on chain" : "Not yet"}</dd></div>
          </dl>
          {log.lines.length > 0 && <Log lines={log.lines} />}
        </details>
      )}
    </div>
  );
}

// ---- step 2 -------------------------------------------------------------------

function readHint(): ImportHint | null {
  try { const t = sessionStorage.getItem(IMPORT_KEY); return t ? JSON.parse(t) : null; } catch { return null; }
}

function SealForm({ onSealed, onPending }: { onSealed: (text: string, tx?: string) => void; onPending: (p: Pending) => void }) {
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

  useEffect(() => {
    if (!hint) return;
    const url = `https://raw.githubusercontent.com/${hint.repo}/${encodeURIComponent(hint.branch)}/${hint.path.split("/").map(encodeURIComponent).join("/")}`;
    fetch(url).then(async (r) => { if (!r.ok) throw new Error(String(r.status)); setEnv(await r.text()); setHintErr(false); }).catch(() => setHintErr(true));
  }, [hint]);

  const preview = useMemo((): { entries: DotenvEntry[] | null; note: string | null } => {
    if (!env.trim()) return { entries: null, note: null };
    const scan = scanDotenvx(env);
    if (tab === "plain") {
      if (scan.isDotenvx) return { entries: null, note: "This file is locked by dotenvx. Switch to \"Move from dotenvx\" to bring its values over." };
      const e = parseDotenv(env);
      return { entries: e, note: e.length ? null : "No NAME=value lines found." };
    }
    if (!scan.isDotenvx) return { entries: null, note: "This file isn't locked by dotenvx. Use \"Paste a .env\" instead." };
    if (!keys.trim()) return { entries: null, note: `${scan.encryptedKeys.length} locked values found. Add the matching .env.keys to unlock them here.` };
    try { return { entries: importDotenvx(env, keys).entries, note: null }; }
    catch { return { entries: null, note: "That .env.keys doesn't match this file." }; }
  }, [env, keys, tab]);

  async function seal() {
    if (!id || !preview.entries?.length) return;
    setBusy(true); setErr(null); log.reset();
    let text: string | null = null, grant: Grant | null = null;
    try {
      log.step("Sealing in your browser");
      text = await work<string>("create", { name, owner: id, env: serializeDotenv(preview.entries) });
      const f = parseCoffer(text);
      grant = { op: "create", fileId: f.id, epoch: f.epoch, version: f.version, added: [], removed: [] };
      setEnv(""); setKeys("");
      try { sessionStorage.removeItem(IMPORT_KEY); } catch { /* storage blocked */ }
      log.step("Recording it on QoreChain");
      const txs = await record(id, grant, (_t, hash) => log.step("Fee topped up by the relayer", hash));
      log.done("Recorded on QoreChain", txs[0]?.hash);
      onSealed(text, txs[0]?.hash);
    } catch (e) {
      log.fail();
      setErr(e);
      if (text && grant) { onSealed(text); onPending({ grant, label: "new file" }); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {hint && (
        <div className="hintline">
          <p>Moving <strong>{hint.path}</strong> from <strong>{hint.repo}</strong>.{" "}
            {hint.kind === "plain" ? "It's public right now, so change these values at each provider after sealing the new ones." :
              hint.kind === "dotenvx" ? "We filled in the file from GitHub. Add your .env.keys below; it never leaves this page." : ""}</p>
          <button className="btn btn-quiet btn-sm" onClick={() => { try { sessionStorage.removeItem(IMPORT_KEY); } catch { /* */ } setHint(null); setEnv(""); }}>Clear</button>
        </div>
      )}
      {hintErr && <Problem text={`Couldn't fetch ${hint?.path ?? "the file"} from GitHub. Paste it below instead.`} />}
      <div className="seg seg-sm" role="tablist" aria-label="Source">
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
      <div><button className="btn btn-seal" disabled={busy || !preview.entries?.length} onClick={seal}>{busy ? <><span className="spin" aria-hidden />Sealing</> : `Seal into ${name}.coffer`}</button></div>
      {log.lines.length > 0 && <Progress lines={log.lines} />}
      {err !== null && <Problem error={err} />}
      <p className="muted small">Values stay in this page's memory only. They are never saved in this browser.</p>
    </div>
  );
}

function Sealed({ file, text, tx, onNew }: { file: CofferFile; text: string; tx: string | null; onNew: () => void }) {
  return (
    <div className="stack">
      <Result tone="blue">Sealed. Safe to commit.</Result>
      <p className="muted">Put <strong>{file.name}.coffer</strong> in your repo, public or private. Only the people you share it with can open it.</p>
      <div className="row">
        <button className="btn btn-seal" onClick={() => download(`${file.name}.coffer`, text)}>Download {file.name}.coffer</button>
        <button className="btn btn-quiet" onClick={() => { if (confirm("Start a new file? Download this one first if you need it.")) onNew(); }}>Seal another file</button>
      </div>
      <details className="raw">
        <summary>Details</summary>
        <dl className="facts">
          <div><dt>File id</dt><dd className="mono">{file.id}</dd></div>
          <div><dt>Epoch</dt><dd className="mono">{String(file.epoch)}</dd></div>
          <div><dt>Version</dt><dd className="mono">{String(file.version)}</dd></div>
          {tx && <div><dt>Record on QoreChain</dt><dd><TxLink hash={tx} /></dd></div>}
        </dl>
        <pre className="mono">{text}</pre>
      </details>
    </div>
  );
}

// ---- step 3 -------------------------------------------------------------------

async function getTeammate(): Promise<string> {
  const r = await api<{ address: string }>("/api/teammate");
  if (!r.address) throw new Error("The demo teammate isn't available right now.");
  return r.address;
}

function Share({ file, fileText, onFile, teammate, setTeammate, onPending }: { file: CofferFile; fileText: string; onFile: (t: string) => void; teammate: string | null; setTeammate: (a: string) => void; onPending: (p: Pending) => void }) {
  const { id } = useIdentity();
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [last, setLast] = useState<{ who: string; address: string } | null>(null);
  const log = useLog();

  async function shareTo(address: string, who: string, label: string) {
    if (!id) return;
    setBusy(label); setErr(null); setLast(null); log.reset();
    let grant: Grant | null = null;
    try {
      if (file.readers.includes(address)) throw new Error("They can already open this file.");
      log.step("Finding their key on QoreChain");
      const reader = await fetchReader(net, address);
      log.step("Sealing a new key to them");
      const text = await work<string>("share", { text: fileText, owner: id, readers: [reader] });
      const g = parseCoffer(text);
      grant = { op: "share", fileId: g.id, epoch: g.epoch, version: g.version, added: [address], removed: [] };
      onFile(text);
      log.step("Recording the share on QoreChain");
      const txs = await record(id, grant, (_t, hash) => log.step("Fee topped up by the relayer", hash));
      log.done("Share recorded", txs[0]?.hash);
      setLast({ who, address });
      setAddr("");
    } catch (e) {
      log.fail();
      setErr(e);
      if (grant) onPending({ grant, label: "share" });
    } finally {
      setBusy(null);
    }
  }

  async function addTeammate() {
    setErr(null);
    try {
      const a = teammate ?? await getTeammate();
      setTeammate(a);
      await shareTo(a, "the demo teammate", "teammate");
    } catch (e) { setErr(e); }
  }

  const mateIn = !!teammate && file.readers.includes(teammate);
  return (
    <div className="stack">
      <p>Add someone by their address. Coffer finds their key on QoreChain, so they don't have to send you anything.</p>
      <form className="door-row" onSubmit={(e) => { e.preventDefault(); const a = addr.trim(); if (a) void shareTo(a, short(a, 8, 5), "addr"); }}>
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Their address, qor1…" aria-label="Their address" spellCheck={false} autoComplete="off" />
        <button className="btn btn-seal" disabled={!!busy || !addr.trim()}>{busy === "addr" ? <><span className="spin" aria-hidden />Sharing</> : "Share"}</button>
      </form>
      <div className="row">
        <button className="btn btn-line" disabled={!!busy || mateIn} onClick={addTeammate}>
          {busy === "teammate" ? <><span className="spin" aria-hidden />Sharing with the demo teammate</> : mateIn ? "Demo teammate added" : "Add the demo teammate"}
        </button>
        <span className="muted small">A test teammate run by Coffer, so you can try sharing and revoking alone.</span>
      </div>
      {last && file.readers.includes(last.address) && <Result tone="open">Shared with {last.who}.</Result>}
      {busy && <Progress lines={log.lines} bare />}
      {err !== null && <Problem error={err} />}
      <FileView file={file} me={id?.address} teammate={teammate} />
    </div>
  );
}

// ---- step 4 -------------------------------------------------------------------

const REFUSED: Record<string, string> = {
  NOT_A_READER: "They're not on the list any more.",
  ROLLBACK: "This is an old copy. A newer version exists.",
  BAD_SIGNATURE: "Someone changed this file by hand.",
};

function Prove({ file, fileText, oldText, teammate, setTeammate, onRevoked, onPending }: {
  file: CofferFile; fileText: string; oldText: string | null; teammate: string | null; setTeammate: (a: string) => void;
  onRevoked: (before: string, after: string) => void; onPending: (p: Pending) => void;
}) {
  const { id } = useIdentity();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [first, setFirst] = useState<TeammateAnswer | null>(null);
  const [rotate, setRotate] = useState<string[] | null>(null);
  const [second, setSecond] = useState<TeammateAnswer | null>(null);
  const [rollback, setRollback] = useState<TeammateAnswer | null>(null);
  const log = useLog();

  useEffect(() => { if (!teammate) getTeammate().then(setTeammate).catch(() => {}); }, [teammate, setTeammate]);

  const ask = (text: string) => api<TeammateAnswer>("/api/teammate/open", { body: { file: text } });
  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name); setErr(null);
    try { await fn(); } catch (e) { setErr(e); } finally { setBusy(null); }
  }

  const teammateIn = !!teammate && file.readers.includes(teammate);
  const revoked = !!oldText && !!teammate && !teammateIn;

  async function revoke() {
    if (!id || !teammate) return;
    log.reset();
    let grant: Grant | null = null;
    try {
      log.step("Sealing the file again with a new key");
      const r = await work<{ text: string; rotate: string[] }>("revoke", { text: fileText, owner: id, addresses: [teammate] });
      const g = parseCoffer(r.text);
      grant = { op: "revoke", fileId: g.id, epoch: g.epoch, version: g.version, added: [], removed: [teammate] };
      onRevoked(fileText, r.text);
      log.step("Recording the revoke on QoreChain");
      const txs = await record(id, grant, (_t, hash) => log.step("Fee topped up by the relayer", hash));
      log.done("Revoke recorded", txs[0]?.hash);
      setRotate(r.rotate);
      setSecond(null); setRollback(null);
    } catch (e) {
      log.fail();
      if (grant) onPending({ grant, label: "revoke" });
      throw e;
    }
  }

  if (!teammate) return <p className="prog-line"><span className="spin" aria-hidden />Reaching the demo teammate</p>;
  if (!teammateIn && !revoked) return <p className="muted">This proof uses the demo teammate. Add them in step 3 first.</p>;

  return (
    <div className="prove">
      <p className="prove-intro">The demo teammate is a separate person on the Coffer server. They check the file against QoreChain like the CLI does, and tell you only the names they could open.</p>

      <Beat n="a" title="Ask the teammate to open it" answer={first}
        action={teammateIn && <button className="btn btn-line" disabled={!!busy} onClick={() => run("first", async () => setFirst(await ask(fileText)))}>{busy === "first" ? <><span className="spin" aria-hidden />Asking</> : first ? "Ask the teammate once more" : "Ask the teammate"}</button>} />

      <div className={`beat ${revoked ? "beat-done" : ""}`}>
        <span className="beat-n mono">b</span>
        <div className="beat-main">
          <h3>Take their access back</h3>
          {!revoked && <p className="muted">The file is sealed again with a new key they never get.</p>}
          {teammateIn && <button className="btn btn-seal" disabled={!!busy} onClick={() => run("revoke", revoke)}>{busy === "revoke" ? <><span className="spin" aria-hidden />Revoking</> : "Revoke"}</button>}
          {busy === "revoke" && <Progress lines={log.lines} bare />}
          {revoked && (
            <div className="rotate">
              <p className="beat-word t-seal">Revoked</p>
              {rotate ? (
                <>
                  <p>Rotate these {rotate.length} keys: they may have read them before.</p>
                  <Chips names={rotate} />
                </>
              ) : <p>They can't open the current file any more.</p>}
              {log.lines.length > 0 && <details className="steps"><summary>Details</summary><Log lines={log.lines} /></details>}
            </div>
          )}
        </div>
      </div>

      <Beat n="c" title="Ask them again" answer={second} locked={!revoked}
        action={revoked && <button className="btn btn-line" disabled={!!busy} onClick={() => run("second", async () => setSecond(await ask(fileText)))}>{busy === "second" ? <><span className="spin" aria-hidden />Asking</> : "Ask the teammate again"}</button>} />

      <Beat n="d" title="Try the old copy" answer={rollback} locked={!revoked || !oldText}
        sub="Someone puts back the copy from before you revoked them, the one they could open."
        action={revoked && oldText && <button className="btn btn-line" disabled={!!busy} onClick={() => run("rollback", async () => setRollback(await ask(oldText)))}>{busy === "rollback" ? <><span className="spin" aria-hidden />Asking</> : "Send the old copy to the teammate"}</button>} />

      {err !== null && <Problem error={err} />}
    </div>
  );
}

function Beat({ n, title, answer, action, locked, sub }: { n: string; title: string; answer: TeammateAnswer | null; action?: ReactNode; locked?: boolean; sub?: string }) {
  return (
    <div className={`beat ${locked ? "beat-locked" : ""} ${answer ? (answer.opened ? "beat-open" : "beat-refused") : ""}`}>
      <span className="beat-n mono">{n}</span>
      <div className="beat-main">
        <h3>{title}</h3>
        {sub && !answer && <p className="muted">{sub}</p>}
        {action}
        {answer && (answer.opened ? (
          <div className="answer">
            <p className="beat-word t-open">Opened</p>
            <p>They see {answer.keys.length} {answer.keys.length === 1 ? "name" : "names"}, never the values:</p>
            <Chips names={answer.keys} />
            <details className="steps"><summary>Details</summary><p className="mono small">epoch {String(answer.epoch)} · version {String(answer.version)} · signatures checked on QoreChain</p></details>
          </div>
        ) : (
          <div className="answer">
            <p className="beat-word t-seal">Refused</p>
            <p>{(answer.code && REFUSED[answer.code]) ?? answer.error}</p>
            <details className="steps"><summary>Details</summary><p className="mono small">{answer.code ? `${answer.code}: ` : ""}{answer.error}</p></details>
          </div>
        ))}
      </div>
    </div>
  );
}
