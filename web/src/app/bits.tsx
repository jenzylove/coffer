// Small pieces shared by the app screens.
import { useState, type DragEvent, type ReactNode } from "react";
import { short, txUrl } from "../lib/net.ts";

export function TxLink({ hash }: { hash: string }) {
  return <a className="mono txlink" href={txUrl(hash)} target="_blank" rel="noreferrer" title={hash}>{short(hash, 8, 6)}</a>;
}

export interface LogLine { text: string; hash?: string; state: "doing" | "done" | "err" }

export function Log({ lines }: { lines: LogLine[] }) {
  if (!lines.length) return null;
  return (
    <ol className="log" aria-live="polite">
      {lines.map((l, i) => (
        <li key={i} className={`log-${l.state}`}>
          <span className="log-dot" aria-hidden />
          <span>{l.text}</span>
          {l.hash && <TxLink hash={l.hash} />}
        </li>
      ))}
    </ol>
  );
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
