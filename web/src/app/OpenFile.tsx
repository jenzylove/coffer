// "Open a file": check any .env.coffer against QoreChain, show who can read it and
// its on chain history, and open it if this address is a reader. Values stay in
// this component's memory and appear one at a time, only on click.
import { useEffect, useMemo, useState } from "react";
import { useIdentity } from "../lib/identity.tsx";
import { errCode, errText, net, short } from "../lib/net.ts";
import { checkFile, explain, remember, type CheckResult } from "../lib/ops.ts";
import { openCoffer, parseCoffer, type CofferFile } from "../../../src/core/vault.ts";
import { parseDotenv, type DotenvEntry } from "../../../src/core/dotenv.ts";
import { grantHistory, type GrantRecord } from "../../../src/chain/qore.ts";
import { DropText, Msg, TxLink } from "./bits.tsx";

export function OpenFile() {
  const { id } = useIdentity();
  const [text, setText] = useState("");
  const [file, setFile] = useState<CofferFile | null>(null);
  const [check, setCheck] = useState<{ ok: true; r: CheckResult } | { ok: false; code?: string; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [entries, setEntries] = useState<DotenvEntry[] | null>(null);

  const mine = (() => { try { return localStorage.getItem("coffer.file"); } catch { return null; } })();

  async function load(t: string) {
    setText(t); setErr(null); setCheck(null); setFile(null); setEntries(null);
    if (!t.trim()) return;
    let f: CofferFile;
    try { f = parseCoffer(t); } catch (e) { setErr(explain(errCode(e), errText(e))); return; }
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

  function open() {
    if (!file || !id) return;
    setErr(null);
    try { setEntries(parseDotenv(new TextDecoder().decode(openCoffer(file, id.sealKeys)))); }
    catch (e) { setErr(explain(errCode(e), errText(e))); }
  }

  const isReader = !!file && !!id && file.readers.includes(id.address);

  return (
    <div className="flow">
      <section className="step step-now">
        <div className="step-body">
          <DropText id="cofferfile" label=".env.coffer" value={text} onChange={(t) => void load(t)} rows={5} placeholder="Paste a sealed file, or drop it here" />
          {mine && !text && <button className="btn btn-quiet btn-sm" onClick={() => void load(mine)}>Use the file from the guided flow</button>}
          {err && <Msg kind="err">{err}</Msg>}
        </div>
      </section>

      {file && (
        <>
          <div className={`verdict ${check ? (check.ok ? "verdict-ok" : "verdict-bad") : ""}`} aria-live="polite">
            {busy || !check ? <p className="muted">Checking signatures and the chain record on QoreChain…</p> : check.ok ? (
              <>
                <p className="beat-word t-open display">Checks out</p>
                <p>The owner's and the writer's ML-DSA-87 signatures match the keys registered on QoreChain, and this copy is not older than the owner's latest record.</p>
              </>
            ) : (
              <>
                <p className="beat-word t-seal display">Refused</p>
                <p>{explain(check.code, check.msg)}</p>
                <p className="muted small mono">{check.code ? `${check.code}: ` : ""}{check.msg}</p>
                <p className="muted small">Coffer won't open a file that fails these checks.</p>
              </>
            )}
          </div>

          <FileView file={file} me={id?.address} history={check?.ok ? check.r.history : undefined} />

          {check?.ok && (
            <section className="opened">
              {!id ? <p className="muted">Make or restore your address in "Seal and share" to open files shared with you.</p> :
                !isReader ? <Msg kind="note">Your address ({short(id.address)}) is not a reader of this file. Ask its owner to share it with you.</Msg> :
                  !entries ? <button className="btn btn-seal" onClick={open}>Open with my address</button> :
                    <Values entries={entries} onClose={() => setEntries(null)} />}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Values({ entries, onClose }: { entries: DotenvEntry[]; onClose: () => void }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="values">
      <div className="values-head">
        <p className="label">{entries.length} {entries.length === 1 ? "value" : "values"}. Click one to show it.</p>
        <button className="btn btn-quiet btn-sm" onClick={onClose}>Close</button>
      </div>
      <ul>
        {entries.map((e) => (
          <li key={e.key}>
            <span className="mono vkey">{e.key}</span>
            <button className={`mono vval ${shown[e.key] ? "on" : ""}`} onClick={() => setShown((s) => ({ ...s, [e.key]: !s[e.key] }))} aria-label={shown[e.key] ? `Hide ${e.key}` : `Show ${e.key}`}>
              {shown[e.key] ? (e.value || "(empty)") : "••••••••••••"}
            </button>
            <button className="copybtn" onClick={async () => { try { await navigator.clipboard.writeText(e.value); setCopied(e.key); setTimeout(() => setCopied(null), 1400); } catch { /* blocked */ } }}>
              {copied === e.key ? "Copied" : "Copy"}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">Values live in this page's memory only. Close the page and they are gone.</p>
    </div>
  );
}

/** The team view: readers, epoch, version, last writer, and the records on chain. */
export function FileView({ file, me, teammate, history: given }: { file: CofferFile; me?: string; teammate?: string | null; history?: GrantRecord[] }) {
  const [open, setOpen] = useState(false);
  const [hist, setHist] = useState<GrantRecord[] | null>(given ?? null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setHist(given ?? null); }, [given, file.epoch, file.version]);
  useEffect(() => {
    if (!open || hist) return;
    grantHistory(net, file.owner, file.id).then(setHist).catch((e) => setErr(errText(e)));
  }, [open, hist, file.owner, file.id]);
  const tag = (a: string) => [a === file.owner ? "owner" : null, a === me ? "you" : null, a === teammate ? "demo teammate" : null].filter(Boolean).join(", ");
  const sorted = useMemo(() => [...file.readers].sort((a, b) => (a === file.owner ? -1 : b === file.owner ? 1 : 0)), [file]);

  return (
    <section className="team" aria-label="Who can read this file">
      <dl className="facts">
        <div><dt>File</dt><dd className="mono">{file.name}.coffer</dd></div>
        <div><dt>Epoch</dt><dd className="mono">{String(file.epoch)}</dd></div>
        <div><dt>Version</dt><dd className="mono">{String(file.version)}</dd></div>
        <div><dt>Last written by</dt><dd>{file.writer === file.owner ? "the owner" : <span className="mono">{short(file.writer)}</span>}</dd></div>
      </dl>
      <p className="label">Readers ({file.readers.length})</p>
      <ul className="readers">
        {sorted.map((a) => (
          <li key={a}><span className="mono">{a}</span>{tag(a) && <span className="tag">{tag(a)}</span>}</li>
        ))}
      </ul>
      <details className="raw" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>See the records on QoreChain</summary>
        {err ? <Msg kind="err">{err}</Msg> : !hist ? <p className="muted small">Reading the owner's records…</p> : hist.length === 0 ? <p className="muted small">No records for this file on chain yet.</p> : (
          <ol className="records">
            {hist.map((h) => (
              <li key={h.hash}>
                <span className="mono rec-time">{h.time.slice(0, 16).replace("T", " ")}</span>
                <span className={`rec-op rec-${h.op}`}>{h.op}</span>
                <span className="mono">epoch {String(h.epoch)}</span>
                <span className="rec-who">{[...h.added.map((a) => `added ${short(a)}`), ...h.removed.map((a) => `removed ${short(a)}`)].join(", ")}</span>
                <TxLink hash={h.hash} />
              </li>
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}
