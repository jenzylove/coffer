// Small pieces shared by the app screens. Rule: a plain sentence first;
// addresses, hashes, codes and logs one tap away behind "Details".
import { useState, type DragEvent, type ReactNode } from "react";
import { short, txUrl, errCode, errText } from "../lib/net.ts";
import { explain } from "../lib/ops.ts";

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return <a className="mono txlink" href={txUrl(hash)} target="_blank" rel="noreferrer" title={hash}>{label ?? short(hash, 8, 6)}</a>;
}

export interface LogLine { text: string; hash?: string; state: "doing" | "done" | "err" }

/** The full step list, for Details. */
export function Log({ lines }: { lines: LogLine[] }) {
  if (!lines.length) return null;
  return (
    <ol className="log">
      {lines.map((l, i) => (
        <li key={i} className={`log-${l.state}`}>
          <span className="log-dot" aria-hidden />
          <span>{l.text}</span>
          {l.hash ? <TxLink hash={l.hash} /> : <span />}
        </li>
      ))}
    </ol>
  );
}

/** One line that changes while work is going on; the steps live behind Details. */
export function Progress({ lines, bare = false }: { lines: LogLine[]; bare?: boolean }) {
  if (!lines.length) return null;
  const doing = lines.find((l) => l.state === "doing");
  const n = lines.filter((l) => l.state === "done").length;
  return (
    <div className="progress" aria-live="polite">
      {doing && (
        <p className="prog-line">
          <span className="spin" aria-hidden />
          <span>{doing.text}</span>
        </p>
      )}
      {doing && <span className="prog-bar" aria-hidden><span style={{ width: `${Math.min(92, 18 + n * 22)}%` }} /></span>}
      {!bare && (
        <details className="steps">
          <summary>Details</summary>
          <Log lines={lines} />
        </details>
      )}
    </div>
  );
}

/** A problem in plain words, with the raw code and message one tap away. */
export function Problem({ error, text }: { error?: unknown; text?: string }) {
  const code = error ? errCode(error) : undefined;
  const raw = error ? errText(error) : undefined;
  const plain = text ?? explain(code, raw ?? "");
  return (
    <div className="problem" role="alert">
      <p>{plain}</p>
      {raw && raw !== plain && (
        <details className="steps">
          <summary>Details</summary>
          <p className="mono small">{code ? `${code}: ` : ""}{raw}</p>
        </details>
      )}
    </div>
  );
}

/** A short address with a copy button; the full one is in the title and the clipboard. */
export function Addr({ a, className = "" }: { a: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className={`addr-short ${className}`}>
      <span className="mono addr-v" title={a}>{short(a, 8, 5)}</span>
      <button className="copybtn" onClick={async () => { try { await navigator.clipboard.writeText(a); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* blocked */ } }} aria-label="Copy the full address">
        {done ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export function Chips({ names }: { names: string[] }) {
  return <p className="chips">{names.map((n) => <span key={n} className="chip">{n}</span>)}</p>;
}

/** The result of a step: one sentence in its state colour. */
export function Result({ tone, children }: { tone: "open" | "blue" | "seal"; children: ReactNode }) {
  return <p className={`result tone-${tone}`}><span className="result-dot" aria-hidden />{children}</p>;
}

/** A text area that also takes a dropped file. */
export function DropText({ value, onChange, label, placeholder, rows = 7, id }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string; rows?: number; id: string }) {
  const [over, setOver] = useState(false);
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onChange(await f.text());
  };
  return (
    <div className={`drop ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <label htmlFor={id} className="label">{label}</label>
      <textarea id={id} className="mono" rows={rows} value={value} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      <div className="drop-foot">
        <span className="muted small">Paste, or drop the file here.</span>
        <label className="btn btn-quiet btn-sm">
          Choose a file
          <input type="file" className="sr" onChange={async (e) => { const f = e.target.files?.[0]; if (f) onChange(await f.text()); e.target.value = ""; }} />
        </label>
      </div>
    </div>
  );
}

export function Step({ n, title, state, summary, children, id }: { n: number; title: string; state: "locked" | "now" | "done"; summary?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <section className={`step step-${state}`} id={id} aria-labelledby={`step-${n}`}>
      <header className="step-head">
        <span className="step-n mono" aria-hidden>{state === "done" ? "✓" : n}</span>
        <h2 id={`step-${n}`}>{title}</h2>
        {summary && <span className="step-sum">{summary}</span>}
      </header>
      <div className="step-body">{children}</div>
    </section>
  );
}

export function Msg({ kind, children }: { kind: "err" | "ok" | "note"; children: ReactNode }) {
  return <p className={`msg msg-${kind}`} role={kind === "err" ? "alert" : undefined}>{children}</p>;
}
