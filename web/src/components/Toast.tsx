// A short confirmation after an action ("Shared with qor1…. It's in their Coffer now.").
// toast() can be called from anywhere; <Toaster /> shows the newest for a few seconds.
import { useEffect, useState } from "react";

type Listener = (t: { id: number; text: string }) => void;
const listeners = new Set<Listener>();
let seq = 0;

export function toast(text: string) {
  const t = { id: ++seq, text };
  for (const l of listeners) l(t);
}

export function Toaster() {
  const [t, setT] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => {
    const l: Listener = (x) => setT(x);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => {
    if (!t) return;
    const h = window.setTimeout(() => setT((cur) => (cur?.id === t.id ? null : cur)), 6000);
    return () => window.clearTimeout(h);
  }, [t]);
  return (
    <div className="toast-wrap" aria-live="polite" role="status">
      {t && (
        <div className="toast" key={t.id}>
          <span className="toast-mark" aria-hidden>✓</span>
          <span>{t.text}</span>
          <button className="toast-x" aria-label="Close" onClick={() => setT(null)}>×</button>
        </div>
      )}
    </div>
  );
}
