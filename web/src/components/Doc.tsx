// The one motif: a classified document. Values sit under black redaction bars
// for everyone except the people you name; stamps land on the result.
import { useEffect, useState, type ReactNode } from "react";

/** Shorten a value for display: about 14 characters, then an ellipsis. */
export const trunc = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A plain black redaction bar, `w` characters wide. */
export function Bar({ w = 10, className = "" }: { w?: number; className?: string }) {
  return <span className={`bar ${className}`} style={{ width: `${w}ch` }} aria-hidden />;
}

/**
 * A value that a black bar slides over (left to right) when `sealed`.
 * Once sealed the text underneath is hidden from screen readers and selection too.
 */
export function Sealable({ value, sealed, delay = 0 }: { value: string; sealed: boolean; delay?: number }) {
  // once the bar has covered it, the value itself leaves the page: only blanks of the same width stay
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!sealed) { setGone(false); return; }
    const t = setTimeout(() => setGone(true), 600 + delay);
    return () => clearTimeout(t);
  }, [sealed, delay]);
  return (
    <span className={`sv ${sealed ? "is-sealed" : ""}`}>
      <span className="sv-text" aria-hidden={sealed}>{gone ? " ".repeat(value.length) : value}</span>
      <span className="sv-bar" style={{ transitionDelay: `${delay}ms` }} aria-hidden />
      {sealed && <span className="sr">sealed value</span>}
    </span>
  );
}

/** A rubber stamp: outlined, letterspaced, a little rotated. Lands from 1.15 to 1. */
export function Stamp({ children, tone = "green", className = "" }: { children: ReactNode; tone?: "green" | "red" | "ink"; className?: string }) {
  return <span className={`stamp stamp-${tone} ${className}`}>{children}</span>;
}

/** An outlined label, not rotated: for facts like "secp256k1". */
export function Tag({ children, tone = "red" }: { children: ReactNode; tone?: "green" | "red" | "ink" }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

/** The document sheet: white paper, a dashed header line, mono body. */
export function Sheet({ left, right, children, className = "", stamp }: { left: ReactNode; right?: ReactNode; children: ReactNode; className?: string; stamp?: ReactNode }) {
  return (
    <div className={`sheet ${className}`}>
      <div className="sheet-head"><span>{left}</span>{right !== undefined && <span>{right}</span>}</div>
      {stamp && <div className="sheet-stamp">{stamp}</div>}
      <div className="sheet-body">{children}</div>
    </div>
  );
}

/** One NAME=value line, the value sealed or not. */
export function EnvLine({ name, value, sealed, delay }: { name: string; value: string; sealed: boolean; delay?: number }) {
  return <div className="env-line"><span className="env-k">{name}=</span><Sealable value={value} sealed={sealed} delay={delay} /></div>;
}

export function splitLine(l: string): [string, string] {
  const i = l.indexOf("=");
  return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1)];
}
