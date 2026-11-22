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
          <span>{l.text}</span>
          {l.hash ? <TxLink hash={l.hash} /> : <span />}
        </li>
      ))}
    </ol>
  );
}

/** One line that changes while work is going on, with a thin orange bar. */
export function Progress({ lines }: { lines: LogLine[] }) {
  const doing = lines.find((l) => l.state === "doing");
  if (!doing) return null;
  const n = lines.filter((l) => l.state === "done").length;
  return (
    <div className="progress" aria-live="polite">
      <span className="prog-bar" aria-hidden><span style={{ width: `${Math.min(92, 14 + n * 20)}%` }} /></span>
      <p className="prog-line mono">{doing.text}…</p>
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
          <p className="mono">{code ? `${code}: ` : ""}{raw}</p>
        </details>
      )}
    </div>
  );
}

/** A short address with a copy button; the full one is in the title and the clipboard. */
export function Addr({ a }: { a: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="addr-short">
      <span className="mono addr-v" title={a}>{short(a, 8, 4)}</span>
      <button className="copy" onClick={async () => { try { await navigator.clipboard.writeText(a); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* blocked */ } }} aria-label="Copy the full address">
        {done ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export function Chips({ names }: { names: string[] }) {
  return <p className="chips">{names.map((n) => <span key={n} className="chip mono">{n}</span>)}</p>;
}

/** The result of a step: one sentence; the key word may be orange. */
export function Result({ children }: { children: ReactNode }) {
  return <p className="result">{children}</p>;
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
        <span>Paste, or drop the file here.</span>
        <label className="text-act">
          Choose a file
          <input type="file" className="sr" onChange={async (e) => { const f = e.target.files?.[0]; if (f) onChange(await f.text()); e.target.value = ""; }} />
        </label>
      </div>
    </div>
  );
}
