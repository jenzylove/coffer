// The hero: a glass seal that seals, opens and refuses for real. The crypto runs
// in a Web Worker (fresh ML-KEM-1024 keys once per visit, a fresh seal each loop),
// so the page never blocks. The stage is plain DOM and CSS by default; on a
// capable desktop the three.js glass takes over once the page is idle, and hands
// back to CSS if it can't hold 40 fps.
import { useEffect, useRef, useState } from "react";
import type { Glass } from "./glass.ts";
import { work } from "../lib/crypto.ts";

const PLAIN = [
  "OPENAI_API_KEY=sk-proj-••••••••",
  "DATABASE_URL=postgres://app:••••@db/main",
  "STRIPE_SECRET_KEY=sk_live_••••••",
];

type Phase = "plain" | "sealed" | "revoked" | "opened" | "refused" | "failed";
const HOLD: Record<string, number> = { plain: 2200, sealed: 2600, revoked: 2400, opened: 3400, refused: 3200 };
const CAPTION: Record<Phase, string> = {
  plain: "A plain .env",
  sealed: "Sealed to two readers",
  revoked: "One reader removed, sealed again",
  opened: "The reader who stays opens it",
  refused: "The removed reader is refused",
  failed: "The live demo stopped: this browser could not run the sealing code",
};

/** Cheap checks on the page; the GPU check runs in the worker so it never blocks. */
async function wantsGl(): Promise<boolean> {
  if (new URLSearchParams(location.search).has("nogl")) return false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (matchMedia("(pointer: coarse)").matches || innerWidth < 900) return false;
  if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  if ((navigator.hardwareConcurrency ?? 4) <= 2) return false;
  if (typeof OffscreenCanvas === "undefined") return false;
  const name = await work<string | null>("gpu").catch(() => null);
  // a software renderer can't hold the glass at 40 fps: keep the CSS stage
  return !!name && !/swiftshader|llvmpipe|software|basic render/i.test(name);
}

const idle = (fn: () => void) => ("requestIdleCallback" in window ? (window as any).requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 1200));

export function Hero() {
  const section = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const glass = useRef<Glass | null>(null);
  const visible = useRef(true);
  const [gl, setGl] = useState(false);
  const [phase, setPhase] = useState<Phase>("plain");
  const [run, setRun] = useState(0);
  const [cipher, setCipher] = useState<string[]>([]);
  const [names, setNames] = useState<string[]>([]);

  // visibility: pause everything when the hero is off screen or the tab is hidden
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { visible.current = !!e?.isIntersecting; });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // three.js, only when it can hold up, and only after the page is idle
  useEffect(() => {
    let off = false;
    const start = () => idle(async () => {
      if (!(await wantsGl()) || off) return;
      import("./glass.ts").then(({ createGlass }) => {
        if (off || !canvas.current) return;
        const g = createGlass(canvas.current, { onSlow: () => { g?.dispose(); glass.current = null; setGl(false); } });
        if (!g) return;
        glass.current = g;
        setGl(true);
      }).catch(() => {});
    });
    if (document.readyState === "complete") start(); else window.addEventListener("load", start, { once: true });
    return () => { off = true; glass.current?.dispose(); glass.current = null; };
  }, []);

  // the real loop, in the worker
  useEffect(() => {
    let stop = false;
    const stretch = new URLSearchParams(location.search).has("slow") ? 4 : 1;
    const ready = async () => { while (!stop && (!visible.current || document.hidden)) await new Promise((ok) => setTimeout(ok, 400)); };
    const wait = async (ms: number) => { await new Promise((ok) => setTimeout(ok, ms * stretch)); await ready(); };
    const show = (p: Phase) => { setPhase(p); setRun((r) => r + 1); };
    (async () => {
      try {
        await work("heroInit", { lines: PLAIN });
        while (!stop) {
          show("plain"); setNames([]); glass.current?.plain(PLAIN);
          await wait(HOLD.plain!); if (stop) return;
          const a = await work<{ cipher: string[] }>("heroSeal", { both: true });
          setCipher(a.cipher); show("sealed"); glass.current?.seal(a.cipher);
          await wait(HOLD.sealed!); if (stop) return;
          const b = await work<{ cipher: string[] }>("heroSeal", { both: false });
          setCipher(b.cipher); show("revoked"); glass.current?.seal(b.cipher);
          await wait(HOLD.revoked!); if (stop) return;
          const n = await work<string[]>("heroOpen");
          setNames(n); show("opened"); glass.current?.open(n);
          await wait(HOLD.opened!); if (stop) return;
          if ((await work<string>("heroRefuse")) !== "refused") { show("failed"); return; } // never fake a refusal
          setNames([]); show("refused"); glass.current?.refuse();
          await wait(HOLD.refused!);
        }
      } catch { if (!stop) show("failed"); }
    })();
    return () => { stop = true; };
  }, []);

  const sealedNow = phase === "sealed" || phase === "revoked" || phase === "opened" || phase === "refused";
  return (
    <section className="hero" aria-labelledby="hero-title" ref={section}>
      <div className="studio" aria-hidden />
      <div className={`screen ${gl ? "is-gl" : "is-css"}`}>
        <canvas ref={canvas} className="screen-canvas" aria-hidden />
        {!gl && (
          <div className={`cstage cs-${phase}`} aria-hidden>
            <div className="cs-lines">{PLAIN.map((l) => <span key={l}>{l}</span>)}</div>
            <div className="cs-names">{names.map((n, i) => <span key={n} style={{ transitionDelay: `${i * 120}ms` }}>{n}</span>)}</div>
            <div className="cs-seal">
              <span className="cs-rim cs-rim2" /><span className="cs-rim" />
              <span className="cs-disc">
                <span className="cs-cipher">{sealedNow && cipher.map((c, i) => <span key={c + i}>{c}</span>)}</span>
              </span>
              <span className="cs-ripple" key={run} />
            </div>
            <span className="cs-token cs-reader"><i />Reader</span>
            <span className="cs-token cs-removed"><i />{phase === "refused" ? "Refused: not a reader" : "Removed reader"}</span>
          </div>
        )}
        <div className="screen-copy">
          <h1 id="hero-title">Your .env, sealed to your team.</h1>
          <p>Commit it to any repo. Only the addresses you name can open it. The lock is built to hold against quantum computers.</p>
        </div>
        <div className={`screen-state state-${phase}`} aria-live="polite">
          <span className="state-dot" aria-hidden />
          <span>{CAPTION[phase]}</span>
          <span className="state-live">live in your browser</span>
        </div>
      </div>
      <div className="slabs" aria-hidden><span /><span /></div>
    </section>
  );
}
