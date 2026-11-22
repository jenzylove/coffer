// The hero: a classified document, driven by real crypto in the hero's own
// worker. Ada's and Sam's addresses go on the To line, the values are sealed to
// them, Ada reads them (decrypted for real), then Sam is removed and refused
// (only after the real NOT_A_RECIPIENT). A caption says what each beat is.
import { useEffect, useRef, useState } from "react";
import { workWithin } from "../lib/crypto.ts";
import { short } from "../lib/net.ts";
import { Link } from "../lib/router.tsx";
import { Bar, EnvLine, Sheet, Stamp, splitLine, trunc } from "../components/Doc.tsx";

const PLAIN = [
  "DATABASE_URL=postgres://app:9fQ2v@db",
  "OPENAI_API_KEY=sk-proj-4Zt8w1Lq0aB",
  "STRIPE_KEY=sk_live_51Hx7K2mN",
];
type Phase = "plain" | "to" | "sealed" | "ada" | "sam";
const HOLD: Record<Phase, number> = { plain: 1900, to: 2500, sealed: 2400, ada: 2900, sam: 3600 };
const ORDER: Phase[] = ["plain", "to", "sealed", "ada", "sam"];
const CAPTION: Record<Phase, string> = {
  plain: "Your .env in plain text. Anyone who sees it reads every key.",
  to: "Add your teammates by their Coffer address. Their sealing key is already on QoreChain.",
  sealed: "Coffer seals every value to those addresses. Now it's safe to commit.",
  ada: "Ada is on the list, so Ada's own key opens it.",
  sam: "Remove Sam and the next version is sealed without Sam. Refused.",
};

/** An address typed in, one character at a time. */
function Typed({ text, delay = 0 }: { text: string; delay?: number }) {
  return <span className="typed" style={{ ["--n" as string]: text.length, animationDelay: `${delay}ms` }}>{text}</span>;
}

export function Hero() {
  const section = useRef<HTMLElement>(null);
  const [phase, setPhase] = useState<Phase>("plain");
  const [cycle, setCycle] = useState(0);
  const [who, setWho] = useState<{ ada: string; sam: string } | null>(null);
  const [ada, setAda] = useState<string[] | null>(null);
  const [refused, setRefused] = useState(false);
  const [failed, setFailed] = useState(false);
  // the sheet lays out one frame after the headline, so the first layout stays small (its space is reserved)
  const [docReady, setDocReady] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setTimeout(() => setDocReady(true), 0)); return () => cancelAnimationFrame(r); }, []);

  useEffect(() => {
    let stop = false;
    const stretch = new URLSearchParams(location.search).has("slow") ? 4 : 1;
    // measure the real position each time: a stale observer flag must never freeze the loop
    const onScreen = () => { const b = section.current?.getBoundingClientRect(); return !!b && b.bottom > 0 && b.top < innerHeight; };
    const ready = async () => { while (!stop && (!onScreen() || document.hidden)) await new Promise((ok) => setTimeout(ok, 400)); };
    const wait = async (ms: number) => { await new Promise((ok) => setTimeout(ok, ms * stretch)); await ready(); };
    const call = <T,>(op: string, args: unknown = {}, ms = 8000) => workWithin<T>(op, args, ms);
    (async () => {
      let restarts = 0;
      while (!stop && restarts < 5) {
        try {
          const w = await call<{ ada: string; sam: string }>("heroInit", { lines: PLAIN }, 30000);
          setWho(w);
          while (!stop) {
            setAda(null); setRefused(false); setPhase("plain"); setCycle((c) => c + 1);
            await wait(HOLD.plain); if (stop) return;
            setPhase("to");
            await wait(HOLD.to); if (stop) return;
            await call("heroSeal", { both: true });
            setPhase("sealed");
            await wait(HOLD.sealed); if (stop) return;
            const lines = await call<string[]>("heroOpen");
            setAda(lines); setPhase("ada");
            await wait(HOLD.ada); if (stop) return;
            await call("heroSeal", { both: false }); // sealed again without Sam
            const r = await call<string>("heroRefuse");
            if (r !== "refused") { setFailed(true); return; } // never fake a refusal
            setRefused(true); setPhase("sam");
            await wait(HOLD.sam);
          }
        } catch (e) {
          // a stuck worker was restarted: begin a fresh real loop instead of freezing
          if ((e as { code?: string })?.code === "TIMEOUT" || /restarted/.test(String((e as Error)?.message))) { restarts++; continue; }
          if (!stop) setFailed(true);
          return;
        }
      }
    })();
    return () => { stop = true; };
  }, []);

  const sealed = phase !== "plain" && phase !== "to";
  const addressed = phase !== "plain";
  return (
    <section className="hero" aria-labelledby="hero-title" ref={section}>
      <div className="wrap hero-in">
        <div className="hero-copy">
          <h1 id="hero-title" className="h-display hero-title"><span className="nw">Commit your .env.</span> Only your team can read it.</h1>
          <p className="hero-sub">Each teammate gets a QoreChain address from Coffer in one click. Add them by it and Coffer seals every value to them. Anyone else who opens the repo sees <span className="bar bar-sub" aria-label="a black bar" role="img" />. Remove someone and they can't open the next version.</p>
          <div className="actions">
            <Link to="/app" className="btn">Seal a file</Link>
            <Link to="/#how" className="link">See how it works</Link>
          </div>
        </div>
        <div className="hero-doc">
          {docReady && <><Sheet
            left={sealed ? ".env.coffer, in a public repo" : ".env, plain text"}
            right={sealed ? `readers: ${phase === "sam" ? 1 : 2}` : "not sealed"}
            stamp={sealed ? <Stamp key={`s${cycle}`}>Sealed</Stamp> : null}
          >
            {PLAIN.map((l, i) => { const [k, v] = splitLine(l); return <EnvLine key={k} name={k} value={v} sealed={sealed} delay={i * 140} />; })}
            <div className="to hero-to" key={`to${cycle}`}>
              <span className="to-k">To:</span>
              {!addressed || !who ? <span className="dim">nobody yet</span> : <>
                <span>Ada <Typed text={short(who.ada, 6, 2)} /></span>
                <span className={phase === "sam" ? "struck" : ""}>Sam <Typed text={short(who.sam, 6, 2)} delay={900} /></span>
              </>}
            </div>
            <div className="views">
              <div className="view">
                <p className="view-who"><span>What Ada sees</span><span className={ada ? "ok" : "dim"}>{ada ? "can read" : sealed ? "reader" : "plain text"}</span></p>
                {(ada ?? PLAIN).map((l) => { const [k, v] = splitLine(l); return <p key={k} className="view-line">{k}={ada || !sealed ? trunc(v) : <Bar w={Math.min(12, Math.max(6, v.length / 2))} />}</p>; })}
              </div>
              <div className="view">
                <p className="view-who"><span>What Sam sees</span><span className={phase === "sam" ? "no" : "dim"}>{phase === "sam" ? "removed" : sealed ? "reader" : "plain text"}</span></p>
                {PLAIN.map((l) => { const [k, v] = splitLine(l); return <p key={k} className="view-line">{k}={sealed ? <Bar w={Math.min(12, Math.max(6, v.length / 2))} /> : trunc(v)}</p>; })}
                {refused && <Stamp key={`r${cycle}`} tone="red" className="view-stamp">Refused</Stamp>}
              </div>
            </div>
          </Sheet>
          <div className="hero-cap" aria-live="polite">
            <span className="cap-ticks" aria-hidden>{ORDER.map((p, i) => <i key={p} className={i <= ORDER.indexOf(phase) ? "on" : ""} />)}</span>
            <p className="cap-t" key={phase}>{failed ? "The live demo stopped: this browser couldn't run the sealing code." : CAPTION[phase]}</p>
          </div>
          <p className="note">Live in your browser: real ML-KEM-1024 keys for Ada and Sam, made fresh on this page.</p></>}
        </div>
      </div>
    </section>
  );
}
