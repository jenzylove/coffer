// Section 02's proof: the real Coffer vault code, run in this browser with three
// throwaway identities. No chain here (the app does that part), so the steps are
// instant, but every result below comes from the same functions the CLI uses.
import { useRef, useState } from "react";
import type { Identity } from "../../../src/core/identity.ts";
import type { CofferFile } from "../../../src/core/vault.ts";

type Who = "you" | "one" | "two";
const NAMES: Record<Who, string> = { you: "You", one: "Teammate one", two: "Teammate two" };
const SAMPLE = `DATABASE_URL=postgres://app:change_me@localhost:5432/app
OPENAI_API_KEY=sk-your-key-here
SESSION_SECRET=paste-a-long-random-string`;

interface State {
  file: CofferFile | null;
  text: string | null;
  can: Partial<Record<Who, "open" | "refused">>;
  rotate: string[] | null;
  names: string[] | null;
  note: string | null;
  tamper: string | null;
}
const EMPTY: State = { file: null, text: null, can: {}, rotate: null, names: null, note: null, tamper: null };

export function LocalDemo() {
  const ids = useRef<Record<Who, Identity> | null>(null);
  const lib = useRef<{ v: typeof import("../../../src/core/vault.ts"); d: typeof import("../../../src/core/dotenv.ts") } | null>(null);
  const [env, setEnv] = useState(SAMPLE);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [st, setSt] = useState<State>(EMPTY);
  const [step, setStep] = useState(0);

  async function ready() {
    if (ids.current && lib.current) return { ...lib.current, ids: ids.current };
    const [v, d, idm] = await Promise.all([
      import("../../../src/core/vault.ts"), import("../../../src/core/dotenv.ts"), import("../../../src/core/identity.ts"),
    ]);
    await new Promise((ok) => setTimeout(ok, 20));
    const make = () => idm.identityFromMnemonic(idm.newMnemonic());
    ids.current = { you: make(), one: make(), two: make() };
    lib.current = { v, d };
    return { v, d, ids: ids.current };
  }

  function tryOpen(v: typeof import("../../../src/core/vault.ts"), f: CofferFile, all: Record<Who, Identity>) {
    const can: State["can"] = {};
    for (const w of ["you", "one", "two"] as Who[]) {
      try { v.openCoffer(f, all[w].sealKeys); can[w] = "open"; }
      catch (e) { if ((e as { code?: string }).code === "NOT_A_READER") can[w] = "refused"; else throw e; }
    }
    return can;
  }

  async function act(name: string, fn: () => Promise<void>) {
    setBusy(name); setErr(null);
    await new Promise((ok) => setTimeout(ok, 20));
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  const seal = () => act("seal", async () => {
    const { v, d, ids } = await ready();
    const entries = d.parseDotenv(env);
    if (!entries.length) throw new Error("Write at least one line like NAME=value first.");
    const f = v.createCoffer({ chainId: "qorechain-diana", name: ".env", owner: ids.you, ownerMlkem: ids.you.sealKeys.mlkemPublicKey, plaintext: new TextEncoder().encode(d.serializeDotenv(entries)) });
    setSt({ ...EMPTY, file: f, text: v.formatCoffer(f), can: tryOpen(v, f, ids), note: `${entries.length} values sealed. Only you can open it so far.` });
    setStep(1);
  });

  const share = () => act("share", async () => {
    const { v, ids } = await ready();
    const f = v.shareCoffer(st.file!, ids.you, ids.you.sealKeys, [ids.one, ids.two].map((i) => ({ address: i.address, mlkemPublicKey: i.sealKeys.mlkemPublicKey })));
    setSt({ ...st, file: f, text: v.formatCoffer(f), can: tryOpen(v, f, ids), note: "Shared with two teammates by their addresses. Each gets the key sealed to their own ML-KEM key." });
    setStep(2);
  });

  const revoke = () => act("revoke", async () => {
    const { v, d, ids } = await ready();
    const { file, rotate } = v.revokeCoffer(st.file!, ids.you, ids.you.sealKeys, [ids.two.address], (p) => d.parseDotenv(new TextDecoder().decode(p)).map((e) => e.key));
    setSt({ ...st, file, text: v.formatCoffer(file), can: tryOpen(v, file, ids), rotate, note: "Teammate two removed. The file is sealed again under a new key they never received." });
    setStep(3);
  });

  const run = () => act("run", async () => {
    const { v, d, ids } = await ready();
    const pq = Object.fromEntries((["you", "one", "two"] as Who[]).map((w) => [ids[w].address, ids[w].pqKey.publicKey]));
    v.verifyCoffer(st.file!, pq);
    const names = d.parseDotenv(new TextDecoder().decode(v.openCoffer(st.file!, ids.one.sealKeys))).map((e) => e.key);
    // a forged copy: someone adds teammate two back by editing the reader list
    const forged = { ...st.file!, readers: [...st.file!.readers, ids.two.address] };
    let tamper = "accepted";
    try { v.verifyCoffer(forged, pq); } catch (e) { tamper = (e as Error).message.split(":")[0] ?? "refused"; }
    setSt({ ...st, names, tamper, note: "Teammate one opened it after checking both signatures. Their program gets these names as environment variables." });
    setStep(4);
  });

  const reset = () => { setSt(EMPTY); setStep(0); setErr(null); };

  const rows: { n: string; title: string; body: string; btn: string; on: () => void; key: string }[] = [
    { n: "1", key: "seal", title: "Seal", body: "Your .env becomes .env.coffer: the values are encrypted under a fresh key, and that key is sealed with ML-KEM-1024 to each reader. The file is safe to commit.", btn: "Seal this file", on: seal },
    { n: "2", key: "share", title: "Share by address", body: "Type a teammate's address. Coffer reads their public key from QoreChain and seals a new key to them. No key swapping, no invite links.", btn: "Share with two teammates", on: share },
    { n: "3", key: "revoke", title: "Revoke", body: "Remove someone and the file is sealed again under a key they never get. They can't open this version or any later one. Coffer lists what to rotate, because they may have read the old values.", btn: "Remove teammate two", on: revoke },
    { n: "4", key: "run", title: "Run", body: "A reader runs their app with the secrets in its environment only. Plain text never touches the disk. Before opening, Coffer checks the owner's and writer's signatures.", btn: "Open as teammate one", on: run },
  ];

  return (
    <div className="demo">
      <div className="demo-rows">
        {rows.map((r, i) => (
          <div key={r.key} className={`demo-row ${step === i ? "now" : step > i ? "done" : ""}`}>
            <span className="demo-n mono">{r.n}</span>
            <div>
              <h3>{r.title}</h3>
              <p>{r.body}</p>
              {i === 0 && step === 0 && (
                <textarea className="mono demo-env" value={env} onChange={(e) => setEnv(e.target.value)} rows={4} spellCheck={false} aria-label="A sample .env to seal" />
              )}
              {step === i && (
                <button className="btn btn-seal" disabled={!!busy} onClick={r.on}>
                  {busy === r.key ? (r.key === "seal" && !ids.current ? "Making three throwaway identities" : "Working") : r.btn}
                </button>
              )}
            </div>
          </div>
        ))}
        {step === 4 && <button className="btn btn-quiet" onClick={reset}>Start over</button>}
        {err && <p className="msg msg-err" role="alert">{err}</p>}
      </div>

      <div className="demo-panel" aria-live="polite">
        <p className="label">What just happened, computed in your browser</p>
        <ul className="who">
          {(["you", "one", "two"] as Who[]).map((w) => {
            const c = st.can[w];
            return (
              <li key={w} className={`who-${c ?? "none"}`}>
                <span>{NAMES[w]}</span>
                <span className="who-state">{c === "open" ? "Can open" : c === "refused" ? (w === "two" && step >= 3 ? "Refused: not a reader" : "Not a reader") : " "}</span>
              </li>
            );
          })}
        </ul>
        {st.note && <p className="demo-note">{st.note}</p>}
        {st.rotate && <p className="demo-rotate"><span className="label">Rotate at the provider</span><span className="mono">{st.rotate.join("  ")}</span></p>}
        {st.names && <p className="demo-rotate"><span className="label">Opened, names only</span><span className="mono">{st.names.join("  ")}</span></p>}
        {st.tamper && <p className="demo-note">A copy with the reader list edited by hand to add teammate two back: <strong className="t-seal">{st.tamper === "accepted" ? "accepted" : "refused"}</strong>{st.tamper !== "accepted" ? ", the owner's signature no longer matches." : "."}</p>}
        {st.file && (
          <details className="demo-raw">
            <summary>See the sealed file ({(st.text?.length ?? 0).toLocaleString("en")} characters, epoch {String(st.file.epoch)}, {st.file.readers.length} {st.file.readers.length === 1 ? "reader" : "readers"})</summary>
            <pre className="mono">{st.text?.split("\n").map((l) => (l.length > 96 ? l.slice(0, 96) + "…" : l)).join("\n")}</pre>
          </details>
        )}
        {!st.file && <p className="muted small">Press "Seal this file" to start. Nothing leaves this page.</p>}
      </div>
    </div>
  );
}
