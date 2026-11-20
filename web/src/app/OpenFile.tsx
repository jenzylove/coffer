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
import { grantHistory, type GrantRecord } from "../../../src/chain/qore.ts";
import { Addr, DropText, Problem, Result, TxLink } from "./bits.tsx";

const VERDICT: Record<string, string> = {
  ROLLBACK: "This is an old copy. A newer version exists, so it won't be opened.",
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

  const mine = (() => { try { return localStorage.getItem("coffer.file"); } catch { return null; } })();

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
    <div className="flow">
      <section className="step step-now">
        <div className="step-body step-body-full">
          <div className={file ? "drop-loaded" : ""}>
            <DropText id="cofferfile" label={file ? `Loaded ${file.name}.coffer. Paste or drop another to check it.` : "Your .env.coffer"} value={text} onChange={(t) => void load(t)} rows={file ? 2 : 5} placeholder="Paste a sealed file, or drop it here" />
          </div>
          {mine && !text && <button className="btn btn-quiet btn-sm" onClick={() => void load(mine)}>Use the file from Seal and share</button>}
          {err !== null && <Problem error={err} text={errCode(err) === "BAD_FORMAT" ? "This isn't a Coffer file." : undefined} />}
        </div>
      </section>

      {file && (
        <>
          <div className={`verdict ${check ? (check.ok ? "verdict-ok" : "verdict-bad") : ""}`} aria-live="polite">
            {busy || !check ? <p className="prog-line"><span className="spin" aria-hidden />Checking it against QoreChain</p> : check.ok ? (
              <>
                <p className="beat-word t-open">Checks out</p>
                <p>Signed by its owner, and the newest version on QoreChain.</p>
                <p className="muted">Owner: <span className="mono">{short(file.owner)}</span>. A valid signature proves who made it, not that you know them: check this is your teammate.</p>
              </>
            ) : (
              <>
                <p className="beat-word t-seal">Refused</p>
                <p>{VERDICT[check.code ?? ""] ?? explain(check.code, check.msg)}</p>
                <details className="steps"><summary>Details</summary><p className="mono small">{check.code ? `${check.code}: ` : ""}{check.msg}</p></details>
              </>
            )}
          </div>

          <FileView file={file} me={id?.address} history={check?.ok ? check.r.history : undefined} />

          {check?.ok && (
            <section className="opened">
              {!id ? <p className="muted">Make or restore your address in "Seal and share" to open files shared with you.</p> :
                !isReader ? <Result tone="seal">You're not on the list for this file. Ask its owner to share it with you.</Result> :
                  !entries ? <button className="btn btn-seal" disabled={opening} onClick={open}>{opening ? <><span className="spin" aria-hidden />Opening</> : "Open with my address"}</button> :
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
      <Result tone="open">Opened. {entries.length} {entries.length === 1 ? "value" : "values"}; tap one to show it.</Result>
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
      <div className="values-head">
        <p className="muted small">Values live in this page's memory only. Close the page and they're gone.</p>
        <button className="btn btn-quiet btn-sm" onClick={onClose}>Hide all</button>
      </div>
    </div>
  );
}

const OP_WORDS: Record<string, string> = { create: "Sealed", share: "Shared", revoke: "Revoked" };

/** Who can read the file, as people; the raw numbers and records sit behind Details. */
export function FileView({ file, me, teammate, history: given }: { file: CofferFile; me?: string; teammate?: string | null; history?: GrantRecord[] }) {
  const [open, setOpen] = useState(false);
  const [hist, setHist] = useState<GrantRecord[] | null>(given ?? null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setHist(given ?? null); }, [given, file.epoch, file.version]);
  useEffect(() => {
    if (!open || hist) return;
    grantHistory(net, file.owner, file.id).then(setHist).catch((e) => setErr(errText(e)));
  }, [open, hist, file.owner, file.id]);
  const who = (a: string) => (a === me ? (a === file.owner ? "You, the owner" : "You") : a === teammate ? "Demo teammate" : a === file.owner ? "The owner" : null);
  const sorted = [...file.readers].sort((a, b) => (a === file.owner ? -1 : b === file.owner ? 1 : 0));
  const name = (a: string) => (a === me ? "you" : a === teammate ? "the demo teammate" : short(a, 8, 5));

  return (
    <section className="team" aria-label="Who can open this file">
      <p className="label">Who can open it ({file.readers.length})</p>
      <ul className="people">
        {sorted.map((a) => (
          <li key={a}>
            <span className="person-dot" aria-hidden />
            <span className="person-name">{who(a) ?? "Teammate"}</span>
            <Addr a={a} />
          </li>
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
        <p className="label" style={{ marginTop: 14 }}>Records on QoreChain</p>
        {err ? <Problem text="QoreChain can't be reached right now." error={new Error(err)} /> : !hist ? <p className="muted small">Reading the records…</p> : hist.length === 0 ? <p className="muted small">No records for this file yet.</p> : (
          <ol className="records">
            {hist.map((h) => (
              <li key={h.hash}>
                <span className="rec-time">{new Date(h.time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                <span className={`rec-op rec-${h.op}`}>{OP_WORDS[h.op] ?? h.op}</span>
                <span className="rec-who">{[...h.added.map((a) => `added ${name(a)}`), ...h.removed.map((a) => `removed ${name(a)}`)].join(", ")}</span>
                <TxLink hash={h.hash} label="view" />
              </li>
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}
