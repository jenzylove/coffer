// /app: the guided flow (address, seal, share, prove) and the "open a file" mode.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Page } from "../components/Chrome.tsx";
import { useIdentity, isReady } from "../lib/identity.tsx";
import { api, download, errCode, errText, net, qor, short } from "../lib/net.ts";
import { SETUP_UQOR, dripAndWait, explain, record, remember } from "../lib/ops.ts";
import { createCoffer, formatCoffer, parseCoffer, revokeCoffer, shareCoffer, type CofferFile } from "../../../src/core/vault.ts";
import { parseDotenv, serializeDotenv, type DotenvEntry } from "../../../src/core/dotenv.ts";
import { importDotenvx, scanDotenvx } from "../../../src/core/dotenvx.ts";
import { fetchReader, registerIdentity, type Grant } from "../../../src/chain/qore.ts";
import { IMPORT_KEY, type ImportHint } from "../landing/ScanDoor.tsx";
import { DropText, Log, Msg, Step, type LogLine } from "./bits.tsx";
import { FileView, OpenFile } from "./OpenFile.tsx";

const FILE_KEY = "coffer.file";
const OLD_KEY = "coffer.oldfile";
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const enc = new TextEncoder();
const dec = new TextDecoder();

type TeammateAnswer = { opened: true; keys: string[]; epoch: number | string; version: number | string; verified: boolean } | { opened: false; code?: string; error: string };

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
        <div className="app-grid">
          {mode === "flow" ? <Flow /> : <OpenFile />}
          <aside className="app-aside" aria-label="What this browser keeps">
            <div className="mini-seal" aria-hidden />
            <p>Sealing and opening happen in this browser. It keeps your recovery phrase and sealed files, never a plain value.</p>
          </aside>
        </div>
      </div>
    </Page>
  );
}

function Flow() {
  const ident = useIdentity();
  const { id, status } = ident;
  const ready = isReady(status);
  const [fileText, setFileTextRaw] = useState<string | null>(() => store.get(FILE_KEY));
  const [oldText, setOldTextRaw] = useState<string | null>(() => store.get(OLD_KEY));
  const setFileText = (t: string | null) => { store.set(FILE_KEY, t); setFileTextRaw(t); };
  const setOldText = (t: string | null) => { store.set(OLD_KEY, t); setOldTextRaw(t); };
  const file = useMemo(() => { try { return fileText ? parseCoffer(fileText) : null; } catch { return null; } }, [fileText]);
  const mine = !!file && !!id && file.owner === id.address;
  const [teammate, setTeammate] = useState<string | null>(null);
  const [pending, setPending] = useState<{ grant: Grant; label: string } | null>(null);

  useEffect(() => { if (file) remember(file); }, [file]);
  // a file sealed by another identity is not this flow's file
  useEffect(() => { if (file && id && file.owner !== id.address) { setFileText(null); setOldText(null); } }, [file, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const s1 = ready ? "done" : "now";
  const s2 = !ready ? "locked" : file ? "done" : "now";
  const shared = !!file && file.readers.length > 1;
  const s3 = !file ? "locked" : shared || oldText ? "done" : "now";
  const s4 = !file || (!shared && !oldText) ? "locked" : "now";

  return (
    <div className="flow">
      <Step n={1} title="Your address" state={s1} id="address" summary={id ? <span className="mono">{short(id.address, 10, 6)}</span> : undefined}>
        <Address />
      </Step>
      <Step n={2} title="Seal a file" state={s2} id="seal" summary={file && mine ? <span>{file.name}.coffer · {file.readers.length} {file.readers.length === 1 ? "reader" : "readers"}</span> : undefined}>
        {s2 === "locked" ? <p className="muted">Finish setting up your address first.</p> :
          file && mine ? <Sealed file={file} text={fileText!} onNew={() => { setFileText(null); setOldText(null); setPending(null); }} /> :
            <SealForm onSealed={(t) => { setFileText(t); setOldText(null); }} onPending={setPending} />}
      </Step>
      <Step n={3} title="Share" state={s3} id="share">
        {s3 === "locked" ? <p className="muted">Seal a file first.</p> :
          <Share file={file!} onFile={(t) => setFileText(t)} teammate={teammate} setTeammate={setTeammate} onPending={setPending} />}
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

/** A grant record that failed to land: the file changed, so offer to retry the record. */
function PendingRecord({ pending, onDone }: { pending: { grant: Grant; label: string }; onDone: () => void }) {
  const { id } = useIdentity();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="pending" role="alert">
      <p><strong>The {pending.label} record is not on chain yet.</strong> Your file changed, but readers check the chain record before opening, so add it now.</p>
      {err && <Msg kind="err">{err}</Msg>}
      <button className="btn btn-seal" disabled={busy || !id} onClick={async () => {
        setBusy(true); setErr(null);
        try { await record(id!, pending.grant); onDone(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
      }}>{busy ? "Recording" : "Record it on chain"}</button>
    </div>
  );
}

// ---- step 1 -------------------------------------------------------------------

function Address() {
  const ident = useIdentity();
  const { id, phrase, deriving, status, statusError, checking } = ident;
  const [fresh, setFresh] = useState<string | null>(null);
  const [showPhrase, setShowPhrase] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);

  const add = (l: LogLine) => setLog((x) => [...x.map((y) => (y.state === "doing" ? { ...y, state: "done" as const } : y)), l]);
  const failLast = () => setLog((x) => x.map((y) => (y.state === "doing" ? { ...y, state: "err" as const } : y)));

  if (!phrase) {
    return (
      <div className="stack">
        <p>Your address is where teammates seal files to. Coffer makes it from a 24 word recovery phrase, right here in your browser.</p>
        <div className="row">
          <button className="btn btn-seal" disabled={busy} onClick={async () => { setBusy(true); try { setFresh(await ident.create()); setShowPhrase(true); } finally { setBusy(false); } }}>Make a new address</button>
          <button className="btn btn-line" onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen}>I have a recovery phrase</button>
        </div>
        {pasteOpen && (
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault(); setErr(null);
            try { await ident.restore(paste); setPaste(""); } catch (x) { setErr(errText(x)); }
          }}>
            <label htmlFor="phrase" className="label">Recovery phrase (24 words)</label>
            <textarea id="phrase" className="mono" rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} autoComplete="off" />
            <div><button className="btn btn-seal">Use this phrase</button></div>
            {err && <Msg kind="err">{err}</Msg>}
          </form>
        )}
      </div>
    );
  }

  if (deriving || !id) return <p className="muted">Deriving your keys from the recovery phrase…</p>;

  async function setup() {
    if (!id) return;
    setBusy(true); setErr(null); setLog([]);
    try {
      add({ text: "Checking your address on QoreChain", state: "doing" });
      let st = await ident.refresh();
      if (!st) throw new Error("Could not read your address from QoreChain. Try again in a moment.");
      if (st.uqor < SETUP_UQOR && !(st.mldsa && st.kemIsOurs)) {
        add({ text: "Asking the Coffer relayer to pay for setup", state: "doing" });
        await dripAndWait(id, SETUP_UQOR, (text, hash) => add({ text, hash, state: "doing" }));
      }
      await registerIdentity(net, id, (s, tx) => {
        const text = tx ? (s.startsWith("ML-DSA") ? "Signing key registered" : "Sealing key published: anyone can seal to you now") :
          s.startsWith("registering") ? "Registering your ML-DSA-87 signing key" : "Publishing your ML-KEM-1024 sealing key";
        add({ text, hash: tx?.hash, state: tx ? "done" : "doing" });
      });
      setLog((x) => x.map((y) => (y.state === "doing" ? { ...y, state: "done" as const } : y)));
      st = await ident.refresh();
    } catch (e) {
      failLast();
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const ok = isReady(status);
  return (
    <div className="stack">
      <div className="addr">
        <span className="label">Your address</span>
        <span className="mono addr-v">{id.address}</span>
        <button className="btn btn-quiet btn-sm" onClick={() => navigator.clipboard?.writeText(id.address).catch(() => {})}>Copy</button>
      </div>

      {fresh && (
        <div className="warnline">
          <p><strong>Save your recovery phrase now.</strong> It opens everything shared with this address. Anyone who has it can read those files, and if you lose it, nobody can give it back.</p>
        </div>
      )}
      <div className="row">
        <button className="btn btn-quiet btn-sm" onClick={() => setShowPhrase((v) => !v)} aria-expanded={showPhrase}>{showPhrase ? "Hide recovery phrase" : "Show recovery phrase"}</button>
        <button className="btn btn-quiet btn-sm" onClick={() => download("coffer-recovery-phrase.txt", `Coffer recovery phrase for ${id.address}\nIt opens every Coffer file shared with this address. Keep it private.\n\n${phrase}\n`)}>Download it</button>
        <button className="btn btn-quiet btn-sm" onClick={() => { if (confirm("Remove this address from this browser? Without the recovery phrase you can't open files shared with it.")) ident.forget(); }}>Remove from this browser</button>
      </div>
      {showPhrase && <p className="phrase mono">{phrase}</p>}

      <div className="status">
        {statusError ? <Msg kind="err">Could not reach QoreChain: {statusError}</Msg> : !status ? <p className="muted">{checking ? "Reading your address from QoreChain…" : ""}</p> : (
          <dl className="facts">
            <div><dt>Balance</dt><dd className="mono">{qor(status.uqor)} QOR</dd></div>
            <div><dt>Signing key (ML-DSA-87)</dt><dd>{status.mldsa ? "Registered" : "Not yet"}</dd></div>
            <div><dt>Sealing key (ML-KEM-1024)</dt><dd>{status.kemIsOurs ? "Published" : status.kem ? "A different key is on chain" : "Not yet"}</dd></div>
          </dl>
        )}
      </div>

      {ok ? <Msg kind="ok">Ready. Anyone can seal files to this address now.</Msg> : status && (
        <div className="stack">
          <p>Setup is two transactions on QoreChain: your signing key, then your sealing key. The Coffer relayer pays the 0.054 test QOR.</p>
          <div><button className="btn btn-seal" disabled={busy} onClick={setup}>{busy ? "Setting up" : "Get set up"}</button></div>
        </div>
      )}
      <Log lines={log} />
      {err && <Msg kind="err">{err}</Msg>}
    </div>
  );
}

// ---- step 2 -------------------------------------------------------------------

function readHint(): ImportHint | null {
  try { const t = sessionStorage.getItem(IMPORT_KEY); return t ? JSON.parse(t) : null; } catch { return null; }
}

function SealForm({ onSealed, onPending }: { onSealed: (text: string) => void; onPending: (p: { grant: Grant; label: string } | null) => void }) {
  const { id } = useIdentity();
  const [hint, setHint] = useState<ImportHint | null>(readHint);
  const [tab, setTab] = useState<"plain" | "dotenvx">(hint?.kind === "dotenvx" ? "dotenvx" : "plain");
  const [env, setEnv] = useState("");
  const [keys, setKeys] = useState("");
  const [hintNote, setHintNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const name = hint ? hint.path.split("/").pop() || ".env" : ".env";

  useEffect(() => {
    if (!hint) return;
    const url = `https://raw.githubusercontent.com/${hint.repo}/${encodeURIComponent(hint.branch)}/${hint.path.split("/").map(encodeURIComponent).join("/")}`;
    fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      setEnv(await r.text());
      setHintNote(null);
    }).catch((e) => setHintNote(`Could not fetch ${hint.path} from GitHub (${errText(e)}). Paste it below instead.`));
  }, [hint]);

  // what would be sealed, names only
  const preview = useMemo((): { entries: DotenvEntry[] | null; note: string | null; isDotenvx: boolean } => {
    if (!env.trim()) return { entries: null, note: null, isDotenvx: false };
    const scan = scanDotenvx(env);
    if (tab === "plain") {
      if (scan.isDotenvx) return { entries: null, note: "This file is dotenvx encrypted. Switch to \"Move from dotenvx\" to bring its values over.", isDotenvx: true };
      const e = parseDotenv(env);
      return { entries: e, note: e.length ? null : "No NAME=value lines found.", isDotenvx: false };
    }
    if (!scan.isDotenvx) return { entries: null, note: "This file is not dotenvx encrypted. Use \"Paste a .env\" instead.", isDotenvx: false };
    if (!keys.trim()) return { entries: null, note: `${scan.encryptedKeys.length} encrypted values found. Add the matching .env.keys to decrypt them here.`, isDotenvx: true };
    try { return { entries: importDotenvx(env, keys).entries, note: null, isDotenvx: true }; }
    catch (e) { return { entries: null, note: errText(e), isDotenvx: true }; }
  }, [env, keys, tab]);

  async function seal() {
    if (!id || !preview.entries?.length) return;
    setBusy(true); setErr(null); setLog([]);
    let grant: Grant | null = null;
    try {
      setLog([{ text: `Sealing ${preview.entries.length} values in your browser`, state: "doing" }]);
      await new Promise((ok) => setTimeout(ok, 30));
      const f = createCoffer({ chainId: net.chainId, name, owner: id, ownerMlkem: id.sealKeys.mlkemPublicKey, plaintext: enc.encode(serializeDotenv(preview.entries)) });
      const text = formatCoffer(f);
      grant = { op: "create", fileId: f.id, epoch: f.epoch, version: f.version, added: [], removed: [] };
      setEnv(""); setKeys("");
      try { sessionStorage.removeItem(IMPORT_KEY); } catch { /* storage blocked */ }
      setLog((x) => [...x.map((y) => ({ ...y, state: "done" as const })), { text: "Recording the new file on QoreChain", state: "doing" }]);
      onSealed(text);
      const txs = await record(id, grant, (t, hash) => setLog((x) => [...x, { text: t, hash, state: "done" }]));
      setLog((x) => [...x.map((y) => ({ ...y, state: "done" as const })), ...txs.map((t) => ({ text: "Recorded on chain", hash: t.hash, state: "done" as const }))]);
    } catch (e) {
      setLog((x) => x.map((y) => (y.state === "doing" ? { ...y, state: "err" as const } : y)));
      setErr(errText(e));
      if (grant) onPending({ grant, label: "new file" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {hint && (
        <div className="hintline">
          <p>Moving <span className="mono">{hint.path}</span> from <span className="mono">{hint.repo}</span>.{" "}
            {hint.kind === "plain" ? "It is public in plain text right now, so rotate these values at each provider after sealing the new ones." :
              hint.kind === "dotenvx" ? "Its file is filled in from GitHub. Add your .env.keys below; it is read here and never leaves this page." : ""}</p>
          <button className="btn btn-quiet btn-sm" onClick={() => { try { sessionStorage.removeItem(IMPORT_KEY); } catch { /* */ } setHint(null); setEnv(""); }}>Clear</button>
        </div>
      )}
      {hintNote && <Msg kind="err">{hintNote}</Msg>}
      <div className="seg seg-sm" role="tablist" aria-label="Source">
        <button role="tab" aria-selected={tab === "plain"} onClick={() => setTab("plain")}>Paste a .env</button>
        <button role="tab" aria-selected={tab === "dotenvx"} onClick={() => setTab("dotenvx")}>Move from dotenvx</button>
      </div>
      <DropText id="envtext" label={tab === "plain" ? ".env" : "dotenvx .env (encrypted)"} value={env} onChange={setEnv} placeholder={"NAME=value\nOTHER_NAME=value"} />
      {tab === "dotenvx" && (
        <>
          <DropText id="keystext" label=".env.keys" value={keys} onChange={setKeys} rows={3} placeholder="DOTENV_PRIVATE_KEY=…" />
          <p className="muted small">Decrypted here, in your browser, with the dotenvx key. Nothing is sent anywhere. The copies in your git history stay readable to anyone with that key, so rotate the values when you can.</p>
        </>
      )}
      {preview.note && <p className="muted">{preview.note}</p>}
      {preview.entries && preview.entries.length > 0 && (
        <p className="names"><span className="label">{preview.entries.length} {preview.entries.length === 1 ? "value" : "values"} to seal</span><span className="mono">{preview.entries.map((e) => e.key).join("  ")}</span></p>
      )}
      <div><button className="btn btn-seal" disabled={busy || !preview.entries?.length} onClick={seal}>{busy ? "Sealing" : `Seal into ${name}.coffer`}</button></div>
      <Log lines={log} />
      {err && <Msg kind="err">{err}</Msg>}
      <p className="muted small">The plain text stays in this page's memory only. It is never saved to this browser's storage.</p>
    </div>
  );
}

function Sealed({ file, text, onNew }: { file: CofferFile; text: string; onNew: () => void }) {
  return (
    <div className="stack">
      <p>Sealed. <span className="mono">{file.name}.coffer</span> is safe to commit to any repo. Only its readers can open it.</p>
      <div className="row">
        <button className="btn btn-seal" onClick={() => download(`${file.name}.coffer`, text)}>Download {file.name}.coffer</button>
        <button className="btn btn-quiet" onClick={() => { if (confirm("Start a new file? Download this one first if you need it.")) onNew(); }}>Seal another file</button>
      </div>
      <details className="raw">
        <summary>See the sealed file ({text.length.toLocaleString("en")} characters)</summary>
        <pre className="mono">{text}</pre>
      </details>
    </div>
  );
}

// ---- step 3 -------------------------------------------------------------------

async function getTeammate(): Promise<string> {
  const r = await api<{ address: string }>("/api/teammate");
  if (!r.address) throw new Error("The server has no demo teammate right now.");
  return r.address;
}

function Share({ file, onFile, teammate, setTeammate, onPending }: { file: CofferFile; onFile: (t: string) => void; teammate: string | null; setTeammate: (a: string) => void; onPending: (p: { grant: Grant; label: string } | null) => void }) {
  const { id } = useIdentity();
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);

  async function shareTo(address: string, label: string) {
    if (!id) return;
    setBusy(label); setErr(null); setLog([{ text: `Reading ${short(address)}'s sealing key from QoreChain`, state: "doing" }]);
    let grant: Grant | null = null;
    try {
      if (file.readers.includes(address)) throw new Error("That address is already a reader.");
      const reader = await fetchReader(net, address);
      const g = shareCoffer(file, id, id.sealKeys, [reader]);
      grant = { op: "share", fileId: g.id, epoch: g.epoch, version: g.version, added: [address], removed: [] };
      onFile(formatCoffer(g));
      setLog((x) => [...x.map((y) => ({ ...y, state: "done" as const })), { text: `Sealed a new key to them (epoch ${g.epoch}). Recording the share on chain`, state: "doing" }]);
      const txs = await record(id, grant, (t, hash) => setLog((x) => [...x, { text: t, hash, state: "done" }]));
      setLog((x) => [...x.map((y) => ({ ...y, state: "done" as const })), ...txs.map((t) => ({ text: "Share recorded on chain", hash: t.hash, state: "done" as const }))]);
      setAddr("");
    } catch (e) {
      setLog((x) => x.map((y) => (y.state === "doing" ? { ...y, state: "err" as const } : y)));
      setErr(explain(errCode(e), errText(e)));
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
      await shareTo(a, "teammate");
    } catch (e) { setErr(errText(e)); }
  }

  return (
    <div className="stack">
      <p>Add a reader by their <span className="mono">qor1</span> address. Coffer reads their sealing key from QoreChain, so they don't have to send you anything.</p>
      <form className="door-row" onSubmit={(e) => { e.preventDefault(); const a = addr.trim(); if (a) void shareTo(a, "addr"); }}>
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="qor1…" aria-label="Reader address" className="mono" spellCheck={false} autoComplete="off" />
        <button className="btn btn-seal" disabled={!!busy || !addr.trim()}>{busy === "addr" ? "Sharing" : "Share"}</button>
      </form>
      <div className="row">
        <button className="btn btn-line" disabled={!!busy || (!!teammate && file.readers.includes(teammate))} onClick={addTeammate}>
          {busy === "teammate" ? "Sharing with the demo teammate" : teammate && file.readers.includes(teammate) ? "Demo teammate added" : "Add the demo teammate"}
        </button>
        <span className="muted small">A teammate run by the Coffer server, so you can test sharing and revoking alone. It reports key names only.</span>
      </div>
      <Log lines={log} />
      {err && <Msg kind="err">{err}</Msg>}
      <FileView file={file} me={id?.address} teammate={teammate} />
    </div>
  );
}

// ---- step 4 -------------------------------------------------------------------

function Prove({ file, fileText, oldText, teammate, setTeammate, onRevoked, onPending }: {
  file: CofferFile; fileText: string; oldText: string | null; teammate: string | null; setTeammate: (a: string) => void;
  onRevoked: (before: string, after: string) => void; onPending: (p: { grant: Grant; label: string } | null) => void;
}) {
  const { id } = useIdentity();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [first, setFirst] = useState<TeammateAnswer | null>(null);
  const [rotate, setRotate] = useState<{ names: string[]; hashes: string[] } | null>(null);
  const [second, setSecond] = useState<TeammateAnswer | null>(null);
  const [rollback, setRollback] = useState<TeammateAnswer | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);

  useEffect(() => { if (!teammate) getTeammate().then(setTeammate).catch(() => {}); }, [teammate, setTeammate]);

  const ask = async (text: string) => api<TeammateAnswer>("/api/teammate/open", { body: { file: text } });

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name); setErr(null);
    try { await fn(); } catch (e) { setErr(explain(errCode(e), errText(e))); } finally { setBusy(null); }
  }

  const teammateIn = !!teammate && file.readers.includes(teammate);
  const revoked = !!oldText && !!teammate && !teammateIn;

  async function revoke() {
    if (!id || !teammate) return;
    setLog([{ text: "Sealing the file again under a new key the teammate never gets", state: "doing" }]);
    let grant: Grant | null = null;
    try {
      await new Promise((ok) => setTimeout(ok, 30));
      const { file: g, rotate: names } = revokeCoffer(file, id, id.sealKeys, [teammate], (p) => parseDotenv(dec.decode(p)).map((e) => e.key));
      grant = { op: "revoke", fileId: g.id, epoch: g.epoch, version: g.version, added: [], removed: [teammate] };
      onRevoked(fileText, formatCoffer(g));
      setLog((x) => [...x.map((y) => ({ ...y, state: "done" as const })), { text: `Epoch ${g.epoch}. Recording the revoke on chain`, state: "doing" }]);
      const txs = await record(id, grant, (t, hash) => setLog((x) => [...x, { text: t, hash, state: "done" }]));
      setLog((x) => [...x.map((y) => ({ ...y, state: "done" as const })), ...txs.map((t) => ({ text: "Revoke recorded on chain", hash: t.hash, state: "done" as const }))]);
      setRotate({ names, hashes: txs.map((t) => t.hash) });
      setSecond(null); setRollback(null);
    } catch (e) {
      setLog((x) => x.map((y) => (y.state === "doing" ? { ...y, state: "err" as const } : y)));
      if (grant) onPending({ grant, label: "revoke" });
      throw e;
    }
  }

  if (!teammate) return <p className="muted">Reaching the demo teammate…</p>;
  if (!teammateIn && !revoked) {
    return <p className="muted">This proof uses the demo teammate. Add them in step 3 first.</p>;
  }

  return (
    <div className="prove">
      <p className="prove-intro">The demo teammate is a separate identity on the Coffer server. It holds its own recovery phrase, checks the file against QoreChain the same way the CLI does, and tells you only the names it could open.</p>

      <Beat n="a" title="Ask the teammate to open it" answer={first}
        action={teammateIn && <button className="btn btn-line" disabled={!!busy} onClick={() => run("first", async () => setFirst(await ask(fileText)))}>{busy === "first" ? "Asking" : first ? "Ask again" : "Ask the teammate"}</button>} />

      <div className={`beat ${revoked ? "beat-done" : ""}`}>
        <span className="beat-n mono">b</span>
        <div className="beat-main">
          <h3>Revoke the teammate</h3>
          {!revoked && <p className="muted">The file is sealed again under a new key. The teammate's address is left out of it.</p>}
          {teammateIn && <button className="btn btn-seal" disabled={!!busy} onClick={() => run("revoke", revoke)}>{busy === "revoke" ? "Revoking" : "Revoke"}</button>}
          <Log lines={log} />
          {revoked && (
            <div className="rotate">
              <p className="beat-word t-seal display">Revoked</p>
              {rotate ? (
                <p><span className="label">They may have read these before. Rotate them at the provider:</span><span className="mono">{rotate.names.join("  ")}</span></p>
              ) : <p className="muted">The teammate is no longer a reader of the current file.</p>}
            </div>
          )}
        </div>
      </div>

      <Beat n="c" title="Ask them again" answer={second} locked={!revoked}
        action={revoked && <button className="btn btn-line" disabled={!!busy} onClick={() => run("second", async () => setSecond(await ask(fileText)))}>{busy === "second" ? "Asking" : "Ask the teammate again"}</button>} />

      <Beat n="d" title="Restore the old file" answer={rollback} locked={!revoked || !oldText}
        sub="Someone puts back the copy from before the revoke, the one the teammate could open. The chain record says a newer version exists."
        action={revoked && oldText && <button className="btn btn-line" disabled={!!busy} onClick={() => run("rollback", async () => setRollback(await ask(oldText)))}>{busy === "rollback" ? "Asking" : "Send the old copy to the teammate"}</button>} />

      {err && <Msg kind="err">{err}</Msg>}
    </div>
  );
}

function Beat({ n, title, answer, action, locked, sub }: { n: string; title: string; answer: TeammateAnswer | null; action?: ReactNode; locked?: boolean; sub?: string }) {
  return (
    <div className={`beat ${locked ? "beat-locked" : ""} ${answer ? (answer.opened ? "beat-open" : "beat-refused") : ""}`}>
      <span className="beat-n mono">{n}</span>
      <div className="beat-main">
        <h3>{title}</h3>
        {sub && <p className="muted">{sub}</p>}
        {action}
        {answer && (answer.opened ? (
          <div className="answer">
            <p className="beat-word t-open display">Opened</p>
            <p>They see {answer.keys.length} {answer.keys.length === 1 ? "name" : "names"}, after checking the signatures on QoreChain:</p>
            <p className="mono names-line">{answer.keys.join("  ")}</p>
            <p className="muted small">Epoch {String(answer.epoch)}, version {String(answer.version)}. The server never returns values.</p>
          </div>
        ) : (
          <div className="answer">
            <p className="beat-word t-seal display">Refused</p>
            <p>{explain(answer.code, answer.error)}</p>
            <p className="muted small mono">{answer.code ? `${answer.code}: ` : ""}{answer.error}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
