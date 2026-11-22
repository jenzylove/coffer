// How it works: a scroll story. One document sheet changes per step. Steps 2
// to 4 run Coffer's own vault code in the worker the first time they are
// reached, with throwaway identities for you, Ada and Sam.
import { useEffect, useRef, useState } from "react";
import { work } from "../lib/crypto.ts";
import { short } from "../lib/net.ts";
import { Bar, EnvLine, Sheet, Stamp, splitLine, trunc } from "../components/Doc.tsx";

const ENV = ["DATABASE_URL=postgres://app:s3cret@db/main", "OPENAI_API_KEY=sk-proj-7Hq2xVb9Lm", "STRIPE_KEY=sk_live_51Mz8kQw"];
const STEP_VH = 85;

type Can = Partial<Record<"you" | "one" | "two", "open" | "refused">>;
interface Facts {
  who?: { you: string; ada: string; sam: string };
  sealed?: { count: number };
  shared?: { can: Can; ada: string[] };
  revoked?: { can: Can; rotate: string[] };
  error?: string;
}

const STEPS: { title: string; line: string }[] = [
  { title: "Your .env is plain text.", line: "Anyone who sees the file reads every key." },
  { title: "Seal it.", line: "Coffer locks the values to the people you choose. The file is safe to commit." },
  { title: "Share it by address.", line: "Type a teammate's QoreChain address. Their public key is already on chain, so there's nothing to swap." },
  { title: "Take it back.", line: "Remove someone and the file is locked again under a key they never get." },
  { title: "Run it.", line: "Your app gets the secrets in memory. Nothing is written to disk." },
];

function StorySheet({ step, f }: { step: number; f: Facts }) {
  const sealed = step >= 2 && !!f.sealed; // bars only once the real seal has run
  const ada = f.who ? short(f.who.ada, 6, 2) : "qor1…";
  const sam = f.who ? short(f.who.sam, 6, 2) : "qor1…";
  const working = <p className="sheet-wait">{f.error ? `Couldn't run this step here: ${f.error}` : "Working it out in your browser…"}</p>;
  const needs = step === 2 ? f.sealed : step === 3 ? f.shared : step === 4 ? f.revoked : true;
  const samOut = step >= 4 && f.revoked?.can.two === "refused";
  return (
    <div className="story-doc">
      <Sheet
        className="sheet-big"
        left={sealed ? ".env.coffer" : ".env"}
        right={sealed ? "safe to commit" : "plain text"}
        stamp={sealed && f.sealed ? <Stamp key={`seal${step >= 2}`}>Sealed</Stamp> : null}
      >
        {ENV.map((l, i) => { const [k, v] = splitLine(l); return <EnvLine key={k} name={k} value={v} sealed={sealed} delay={i * 140} />; })}
        {step >= 3 && f.shared && (
          <div className="to">
            <span className="to-k">To:</span>
            <span>Ada · {ada}</span>
            <span className={samOut ? "struck" : ""}>Sam · {sam}</span>
          </div>
        )}
        {!needs && working}
      </Sheet>
      {step === 3 && f.shared && (
        <div className="viewsheet">
          <p className="view-who"><span>What Ada reads</span><span className="ok">can read</span></p>
          {f.shared.ada.map((l) => { const [k, v] = splitLine(l); return <p key={k} className="view-line">{k}={trunc(v, 22)}</p>; })}
        </div>
      )}
      {step === 4 && f.revoked && (
        <div className="viewsheet">
          <p className="view-who"><span>What Sam reads now</span><span className="no">removed</span></p>
          {ENV.map((l) => { const [k, v] = splitLine(l); return <p key={k} className="view-line">{k}=<Bar w={Math.min(14, Math.max(6, v.length / 2))} /></p>; })}
          {samOut && <Stamp tone="red" className="view-stamp">Refused</Stamp>}
          <p className="rotate-line">Rotate these {f.revoked.rotate.length}: {f.revoked.rotate.join(", ")}</p>
        </div>
      )}
      {step === 5 && (
        <div className="runlines">
          <p>$ coffer run -- npm start</p>
          <p className="dim">app started · 3 values in memory · nothing written to disk</p>
        </div>
      )}
    </div>
  );
}

function useFacts(reached: number): Facts {
  const [f, setF] = useState<Facts>({});
  const chain = useRef<Promise<void>>(Promise.resolve());
  const done = useRef(1);
  useEffect(() => {
    // run every step up to the one reached, in order, each exactly once
    while (done.current < Math.min(reached, 4)) {
      const k = ++done.current;
      chain.current = chain.current.then(async () => {
        try {
          if (k === 2) {
            const who = await work<{ you: string; ada: string; sam: string }>("demoInit");
            const s = await work<{ count: number }>("demoSeal", { env: ENV.join("\n") });
            setF((x) => ({ ...x, who, sealed: { count: s.count } }));
          }
          if (k === 3) { const r = await work<{ can: Can; ada: string[] }>("demoShare"); setF((x) => ({ ...x, shared: { can: r.can, ada: r.ada } })); }
          if (k === 4) { const r = await work<{ can: Can; rotate: string[] }>("demoRevoke"); setF((x) => ({ ...x, revoked: { can: r.can, rotate: r.rotate } })); }
        } catch (e) { setF((x) => ({ ...x, error: (e as Error).message })); }
      });
    }
  }, [reached]);
  return f;
}

export function Story() {
  const track = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 899px)").matches);
  const [active, setActive] = useState(1);
  const [reached, setReached] = useState(1);
  const facts = useFacts(reached);

  useEffect(() => {
    const mq = matchMedia("(max-width: 899px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // desktop: the active step follows the scroll position through the tall track
  useEffect(() => {
    if (narrow) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = track.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const step = (innerHeight * STEP_VH) / 100;
      const k = Math.max(1, Math.min(5, Math.floor((-top + step * 0.35) / step) + 1));
      setActive(k);
      // once the story is on screen, work out the next step ahead of time
      if (top < innerHeight) setReached((r) => Math.max(r, Math.min(5, k + 1)));
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    addEventListener("scroll", on, { passive: true });
    addEventListener("resize", on);
    return () => { removeEventListener("scroll", on); removeEventListener("resize", on); if (raf) cancelAnimationFrame(raf); };
  }, [narrow]);

  // mobile: each step computes when it comes into view
  useEffect(() => {
    if (!narrow) return;
    const els = [...document.querySelectorAll<HTMLElement>(".story-m-step")];
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting || e.boundingClientRect.top < 0) setReached((r) => Math.max(r, Number(e.target.getAttribute("data-step")) + 1));
    }, { rootMargin: "0px 0px 30% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [narrow]);

  if (narrow) {
    return (
      <div className="wrap story-m">
        {STEPS.map((s, i) => (
          <div key={s.title} className="story-m-step" id={`story-${i + 1}`} data-step={i + 1}>
            <p className="story-n">{String(i + 1).padStart(2, "0")} / 05</p>
            <h3 className="h-section story-title">{s.title}</h3>
            <p className="story-line">{s.line}</p>
            <StorySheet step={i + 1} f={facts} />
          </div>
        ))}
      </div>
    );
  }

  const s = STEPS[active - 1]!;
  return (
    <div className="story-track" ref={track} style={{ height: `calc(100vh + ${4 * STEP_VH}vh)` }}>
      {STEPS.map((_, i) => <span key={i} id={`story-${i + 1}`} className="story-mark" style={{ top: `${i * STEP_VH}vh` }} aria-hidden />)}
      <div className="story-stage">
        <div className="wrap story-grid">
          <div className="story-left">
            <ol className="story-ticks" aria-label="Steps">
              {STEPS.map((x, i) => <li key={x.title} className={i + 1 === active ? "on" : ""}><span className="sr">Step {i + 1}: {x.title}</span></li>)}
            </ol>
            <div className="story-text" key={active}>
              <p className="story-n">{String(active).padStart(2, "0")} / 05</p>
              <h3 className="h-section story-title">{s.title}</h3>
              <p className="story-line">{s.line}</p>
            </div>
          </div>
          <div className="story-right" aria-live="polite"><StorySheet step={active} f={facts} /></div>
        </div>
      </div>
    </div>
  );
}
