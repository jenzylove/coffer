// "Open a file": check any .env.coffer against QoreChain, show who can read it,
// and open it if this address is on the list. Values stay in this component's
// memory and appear one at a time, only on click.
import { useEffect, useState } from "react";
import { useIdentity } from "../lib/identity.tsx";
import { errCode, errText, net, short } from "../lib/net.ts";
import { checkFile, explain, remember, type CheckResult } from "../lib/ops.ts";
import { work } from "../lib/crypto.ts";
import { parseCoffer, type CofferFile } from "../../../src/core/vault.ts";
import type { DotenvEntry } from "../../../src/core/dotenv.ts";
import type { GrantRecord } from "../../../src/chain/qore.ts";
import { grantHistory } from "../lib/chain.ts";
import { Stamp } from "../components/Doc.tsx";
import { Addr, DropText, Problem, Result, TxLink } from "./bits.tsx";

const VERDICT: Record<string, string> = {
  ROLLBACK: "This is an old copy. A newer version exists, so it won't be opened.",
  UNRECORDED: "QoreChain has no record of this version, so it won't be opened.",
  BAD_SIGNATURE: "Someone changed this file by hand, so it won't be opened.",
  UNKNOWN_KEY: "Whoever signed this file hasn't set up Coffer, so it can't be checked.",
  WRITER_NOT_READER: "The last person to change it isn't on its list, so it won't be opened.",
};

export function OpenFile() {
  const { id } = useIdentity();
  const [text, setText] = useState("");
  const [file, setFile] = useState<CofferFile | null>(null);
  const [check, setCheck] = useState<{ ok: true; r: CheckResult } | { ok: false; code?: string; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [entries, setEntries] = useState<DotenvEntry[] | null>(null);

  async function load(t: string) {
    setText(t); setErr(null); setCheck(null); setFile(null); setEntries(null);
    if (!t.trim()) return;
    let f: CofferFile;
    try { f = parseCoffer(t); } catch (e) { setErr(e); return; }
    setFile(f);
    setBusy(true);
    try {
      const r = await checkFile(f);
      setCheck({ ok: true, r });
      remember(f);
    } catch (e) {
      setCheck({ ok: false, code: errCode(e), msg: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    if (!file || !id) return;
    setErr(null); setOpening(true);
    try { setEntries(await work<DotenvEntry[]>("open", { text, keys: id.sealKeys })); }
    catch (e) { setErr(e); }
    finally { setOpening(false); }
  }

  const isReader = !!file && !!id && file.readers.includes(id.address);

  return (
    <section className="panel" aria-labelledby="h-open">
      <h2 id="h-open" className="h-section">Open a file.</h2>
      <div className={file ? "drop-loaded" : ""}>
        <DropText id="cofferfile" label={file ? `Loaded ${file.name}.coffer. Paste or drop another to check it.` : "Your .env.coffer"} value={text} onChange={(t) => void load(t)} rows={file ? 2 : 6} placeholder="Paste a sealed file, or drop it here" />
      </div>
      {err !== null && <Problem error={err} text={errCode(err) === "BAD_FORMAT" ? "This isn't a Coffer file." : undefined} />}

      {file && (
        <>
          <div className="verdict" aria-live="polite">
            {busy || !check ? <p className="prog-line">Checking it against QoreChain…</p> : check.ok ? (
              <>
                <Stamp className="beat-word">Checks out</Stamp>
                <p>Signed by its owner, and the newest version on QoreChain.</p>
                <p className="muted small">Owner {short(file.owner, 8, 4)}. A valid signature proves who made it, not that you know them: check this is your teammate.</p>
              </>
            ) : (
              <>
                <Stamp tone="red" className="beat-word">Refused</Stamp>
                <p>{VERDICT[check.code ?? ""] ?? explain(check.code, check.msg)}</p>
                <details className="steps"><summary>Details</summary><p className="mono">{check.code ? `${check.code}: ` : ""}{check.msg}</p></details>
              </>
            )}
          </div>

          <FileView file={file} me={id?.address} history={check?.ok ? check.r.history : undefined} />

          {check?.ok && (
            <div className="opened">
              {!id ? <p className="muted">Create your address first to open files shared with you.</p> :
                !isReader ? <Result>You're not on the list for this file. Ask its owner to share it with you.</Result> :
                  !entries ? <button className="btn" disabled={opening} onClick={open}>{opening ? "Opening" : "Open with my address"}</button> :
                    <Values entries={entries} onClose={() => setEntries(null)} />}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Values({ entries, onClose }: { entries: DotenvEntry[]; onClose: () => void }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="values">
      <Result>Opened. {entries.length} {entries.length === 1 ? "value" : "values"}; tap one to show it.</Result>
      <ul>
        {entries.map((e) => (
          <li key={e.key}>
            <span className="mono vkey">{e.key}</span>
            <button className={`mono vval ${shown[e.key] ? "on" : ""}`} onClick={() => setShown((s) => ({ ...s, [e.key]: !s[e.key] }))} aria-label={shown[e.key] ? `Hide ${e.key}` : `Show ${e.key}`}>
              {shown[e.key] ? (e.value || "(empty)") : <span className="bar" style={{ width: "12ch" }} aria-hidden />}
            </button>
            <button className="copy" onClick={async () => { try { await navigator.clipboard.writeText(e.value); setCopied(e.key); setTimeout(() => setCopied(null), 1400); } catch { /* blocked */ } }}>
              {copied === e.key ? "Copied" : "Copy"}
            </button>
          </li>
        ))}
      </ul>
      <div className="acts">
        <span className="muted small">Values live in this page's memory only. Close the page and they're gone.</span>
        <button className="link" onClick={onClose}>Hide all</button>
      </div>
    </div>
  );
}

const OP_WORDS: Record<string, string> = { create: "Sealed", share: "Shared", revoke: "Revoked" };

/** Who can read the file, as people; the raw numbers and records sit behind Details. */
export function FileView({ file, me, history: given }: { file: CofferFile; me?: string; history?: GrantRecord[] }) {
  const [open, setOpen] = useState(false);
  const [hist, setHist] = useState<GrantRecord[] | null>(given ?? null);
  const [err, setErr] = useState(false);
  useEffect(() => { setHist(given ?? null); }, [given, file.epoch, file.version]);
  useEffect(() => {
    if (!open || hist) return;
    grantHistory(file.owner, file.id).then(setHist).catch(() => setErr(true));
  }, [open, hist, file.owner, file.id]);
  const who = (a: string) => (a === me ? (a === file.owner ? "You (owner)" : "You") : a === file.owner ? "Owner" : "Reader");
  const name = (a: string) => (a === me ? "you" : short(a, 6, 4));
  const sorted = [...file.readers].sort((a, b) => (a === file.owner ? -1 : b === file.owner ? 1 : 0));

  return (
    <div className="team" aria-label="Who can open this file">
      <p className="label">Who can open it ({file.readers.length})</p>
      <ul className="people">
        {sorted.map((a) => (
          <li key={a}><span className="person">{who(a)}</span><Addr a={a} /><span /></li>
        ))}
      </ul>
      <details className="raw" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Details</summary>
        <dl className="facts">
          <div><dt>File</dt><dd className="mono">{file.name}.coffer</dd></div>
          <div><dt>File id</dt><dd className="mono">{file.id}</dd></div>
          <div><dt>Epoch</dt><dd className="mono">{String(file.epoch)}</dd></div>
          <div><dt>Version</dt><dd className="mono">{String(file.version)}</dd></div>
        </dl>
        {err ? <p className="muted small">QoreChain can't be reached right now.</p> : !hist ? <p className="muted small">Reading the records…</p> : hist.length === 0 ? <p className="muted small">No records for this file yet.</p> : (
          <ol className="records">
            {hist.map((h) => (
              <li key={h.hash}>
                <span>{new Date(h.time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                <span>{OP_WORDS[h.op] ?? h.op}</span>
                <span>{[...h.added.map((a) => `added ${name(a)}`), ...h.removed.map((a) => `removed ${name(a)}`)].join(", ")}</span>
                <TxLink hash={h.hash} label="view" />
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}
