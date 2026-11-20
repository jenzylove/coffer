// Section 02's proof: Coffer's own vault code, run in a Web Worker with three
// throwaway identities. No chain here (the app does that part), but every
// result below comes from the same functions the CLI uses.
import { useState } from "react";
import { work } from "../lib/crypto.ts";

type Who = "you" | "one" | "two";
type Can = Partial<Record<Who, "open" | "refused">>;
const NAMES: Record<Who, string> = { you: "You", one: "Teammate one", two: "Teammate two" };
const SAMPLE = `DATABASE_URL=postgres://app:change_me@localhost:5432/app
OPENAI_API_KEY=sk-your-key-here
SESSION_SECRET=paste-a-long-random-string`;

export function LocalDemo() {
  const [env, setEnv] = useState(SAMPLE);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [can, setCan] = useState<Can>({});
  const [headline, setHeadline] = useState<{ tone: "blue" | "open" | "seal"; text: string } | null>(null);
  const [chips, setChips] = useState<{ label: string; names: string[] } | null>(null);
  const [raw, setRaw] = useState<string | null>(null);

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  const seal = () => act("seal", async () => {
    const r = await work<{ can: Can; count: number; text: string }>("demoSeal", { env });
    setCan(r.can); setRaw(r.text); setChips(null);
    setHeadline({ tone: "blue", text: `Sealed. ${r.count} values, safe to commit.` });
    setStep(1);
  });
  const share = () => act("share", async () => {
    const r = await work<{ can: Can; text: string }>("demoShare");
    setCan(r.can); setRaw(r.text);
    setHeadline({ tone: "open", text: "Shared with two teammates by address." });
    setStep(2);
  });
  const revoke = () => act("revoke", async () => {
    const r = await work<{ can: Can; rotate: string[]; text: string }>("demoRevoke");
    setCan(r.can); setRaw(r.text);
    setHeadline({ tone: "seal", text: `Teammate two removed. Rotate these ${r.rotate.length} keys.` });
    setChips({ label: "Rotate", names: r.rotate });
    setStep(3);
  });
  const run = () => act("run", async () => {
    const r = await work<{ names: string[]; tamperRefused: boolean }>("demoRun");
    setHeadline({ tone: "open", text: `Opened by teammate one: ${r.names.length} names.${r.tamperRefused ? " A hand edited copy was refused." : ""}` });
    setChips({ label: "Opened", names: r.names });
    setStep(4);
  });
  const reset = () => { setStep(0); setCan({}); setHeadline(null); setChips(null); setRaw(null); setErr(null); };

  const rows = [
    { key: "seal", title: "Seal", body: "Your .env becomes .env.coffer, safe to commit.", btn: "Seal this file", on: seal, wait: "Making three throwaway identities" },
    { key: "share", title: "Share by address", body: "Add teammates by address. No key swapping.", btn: "Share with two teammates", on: share, wait: "Sharing" },
    { key: "revoke", title: "Revoke", body: "Sealed again under a key they never get.", btn: "Remove teammate two", on: revoke, wait: "Revoking" },
    { key: "run", title: "Run", body: "Signatures checked, then opened in memory only.", btn: "Open as teammate one", on: run, wait: "Opening" },
  ];

  return (
    <div className="demo">
      <div className="demo-rows">
        {rows.map((r, i) => (
          <div key={r.key} className={`demo-row ${step === i ? "now" : step > i ? "done" : ""}`}>
            <span className="demo-n mono">{i + 1}</span>
            <div>
              <h3>{r.title}</h3>
              <p>{r.body}</p>
              {i === 0 && step === 0 && (
                <textarea className="mono demo-env" value={env} onChange={(e) => setEnv(e.target.value)} rows={4} spellCheck={false} aria-label="A sample .env to seal" />
              )}
              {step === i && (
                <button className="btn btn-seal" disabled={!!busy} onClick={r.on}>
                  {busy === r.key ? <><span className="spin" aria-hidden />{r.wait}</> : r.btn}
                </button>
              )}
            </div>
          </div>
        ))}
        {step === 4 && <button className="btn btn-quiet" onClick={reset}>Start over</button>}
        {err && <p className="msg msg-err" role="alert">{err}</p>}
      </div>

      <div className="demo-panel" aria-live="polite">
        <p className="label">Computed in your browser</p>
        <ul className="who">
          {(["you", "one", "two"] as Who[]).map((w) => {
            const c = can[w];
            return (
              <li key={w} className={`who-${c ?? "none"}`}>
                <span>{NAMES[w]}</span>
                <span className="who-state">{c === "open" ? "Can open" : c === "refused" ? (w === "two" && step >= 3 ? "Refused" : "Not shared") : " "}</span>
              </li>
            );
          })}
        </ul>
        {headline ? <p className={`demo-head tone-${headline.tone}`}>{headline.text}</p> : <p className="muted small">Press "Seal this file" to start. Nothing leaves this page.</p>}
        {chips && <p className="chips" aria-label={chips.label}>{chips.names.map((n) => <span key={n} className="chip">{n}</span>)}</p>}
        {raw && (
          <details className="demo-raw">
            <summary>Details</summary>
            <pre className="mono">{raw.split("\n").map((l) => (l.length > 80 ? l.slice(0, 80) + "…" : l)).join("\n")}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
