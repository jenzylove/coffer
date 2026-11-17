// The hero: a .env sealed for real in this browser (fresh ML-KEM-1024 keys every
// loop), one reader removed, the remaining reader opening it and the removed one
// bouncing off. The lattice behind it pulses with each step.
import { useEffect, useRef, useState } from "react";
import type { Lattice } from "./lattice.ts";
import { ScanDoor } from "./ScanDoor.tsx";

const PLAIN = [
  "DATABASE_URL=postgres://app:••••@db:5432/main",
  "OPENAI_API_KEY=sk-proj-••••••••••••",
  "STRIPE_SECRET_KEY=sk_live_••••••••••",
];
const WIDTH = PLAIN.map((l) => l.length);

type Phase = "plain" | "sealed" | "revoked" | "opened" | "refused";
const ORDER: Phase[] = ["plain", "sealed", "revoked", "opened", "refused"];
const HOLD: Record<Phase, number> = { plain: 1900, sealed: 2300, revoked: 2300, opened: 2300, refused: 2700 };
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

const CAPTION: Record<Phase, string> = {
  plain: "A plain .env. Anyone who sees it can use it.",
  sealed: "Sealed to two readers. Safe to commit anywhere.",
  revoked: "One reader removed. Sealed again, with fresh keys, for the reader who stays.",
  opened: "The reader who stays opens it.",
  refused: "The removed reader is refused. Not a reader any more.",
};

/** Animates text toward a target, one random glyph at a time. */
function useScramble(target: string[], run: number) {
  const [shown, setShown] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    const from = prev.current;
    prev.current = target;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(target); return; }
    const t0 = performance.now(), dur = 900;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      if (p >= 1) { setShown(target); return; }
      setShown(target.map((line, li) => {
        const old = from[li] ?? "";
        const len = Math.max(line.length, old.length);
        let s = "";
        for (let i = 0; i < len; i++) {
          const settle = (i / len) * 0.6 + li * 0.06;
          if (p >= settle + 0.22) s += line[i] ?? "";
          else if (p >= settle) s += GLYPHS[(Math.random() * GLYPHS.length) | 0];
          else s += old[i] ?? "";
        }
        return s;
      }));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

function chunk(b64: string): string[] {
  let o = 0;
  return WIDTH.map((w) => { const s = b64.slice(o, o + w); o += w; return s; });
}

export function Hero() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const lattice = useRef<Lattice | null>(null);
  const [phase, setPhase] = useState<Phase>("plain");
  const [lines, setLines] = useState<string[]>(PLAIN);
  const [run, setRun] = useState(0);
  const [bytes, setBytes] = useState<number | null>(null);
  const [live, setLive] = useState<"loading" | "live" | "failed">("loading");
  const shown = useScramble(lines, run);

  useEffect(() => {
    let off = false;
    let lat: Lattice | null = null;
    import("./lattice.ts").then(({ createLattice }) => {
      if (off || !canvas.current) return;
      lat = createLattice(canvas.current);
      lattice.current = lat;
    });
    return () => { off = true; lat?.dispose(); };
  }, []);

  useEffect(() => {
    let stop = false;
    (async () => {
      let qs: typeof import("@qorechain/qoreseal");
      try { qs = await import("@qorechain/qoreseal"); } catch { setLive("failed"); return; }
      const enc = new TextEncoder(), dec = new TextDecoder();
      const plaintext = enc.encode(PLAIN.join("\n"));
      const ctx = { chainId: "qorechain-diana", purpose: "coffer:hero" };
      let current: Uint8Array | null = null;
      setLive("live");
      while (!stop) {
        // fresh keys every loop: nothing below is canned
        const reader = qs.generateSealKeys(), removed = qs.generateSealKeys();
        for (const ph of ORDER) {
          if (stop) return;
          if (ph === "plain") { setLines(PLAIN); lattice.current?.setTint("plain"); setBytes(null); }
          if (ph === "sealed") {
            const env = qs.seal({ ...ctx, mode: "mlkem", plaintext, recipients: [{ mlkemPublicKey: reader.mlkemPublicKey }, { mlkemPublicKey: removed.mlkemPublicKey }] });
            setLines(chunk(qs.toBase64Url(env.slice(-120)))); setBytes(env.length);
            lattice.current?.pulse("seal"); lattice.current?.setTint("sealed");
            current = env;
          }
          if (ph === "revoked") {
            const env = qs.seal({ ...ctx, mode: "mlkem", plaintext, recipients: [{ mlkemPublicKey: reader.mlkemPublicKey }] });
            current = env;
            setLines(chunk(qs.toBase64Url(env.slice(-120)))); setBytes(env.length);
            lattice.current?.pulse("seal");
          }
          if (ph === "opened") {
            const out = qs.open({ ...ctx, envelope: current!, keys: reader });
            setLines(dec.decode(out).split("\n"));
            lattice.current?.pulse("open"); lattice.current?.setTint("plain");
          }
          if (ph === "refused") {
            try {
              qs.open({ ...ctx, envelope: current!, keys: removed });
              setLive("failed"); // would mean the removed reader opened it: never fake a refusal
              return;
            } catch (e) {
              if (!qs.isQoreSealError(e, "NOT_A_RECIPIENT")) { setLive("failed"); return; }
            }
            lattice.current?.pulse("refuse"); lattice.current?.setTint("sealed");
          }
          setPhase(ph);
          setRun((r) => r + 1);
          await new Promise((ok) => setTimeout(ok, HOLD[ph]));
        }
      }
    })();
    return () => { stop = true; };
  }, []);

  const sealed = phase === "sealed" || phase === "revoked" || phase === "refused";
  const readerState = phase === "plain" ? "none" : phase === "opened" ? "open" : "keep";
  const removedState = phase === "plain" ? "none" : phase === "sealed" ? "keep" : phase === "refused" ? "refused" : "gone";

  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-canvas" aria-hidden><canvas ref={canvas} /></div>
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">Coffer, for developers and teams who keep secrets in .env files</p>
          <h1 id="hero-title" className="display">Push your secrets to GitHub. <em>Only your team can open them.</em></h1>
          <ScanDoor />
          <p className="lede hero-lede">Coffer seals your <code>.env</code> into a file that is safe to commit to any repo, public or private. Share it by typing a teammate's address. Take access back the same way. A quantum computer later can't open it either.</p>
        </div>

        <figure className={`stage stage-${phase}`} aria-label="Live demo: a .env file sealed, shared, revoked and opened in your browser">
          <div className="stage-file">
            <div className="stage-head">
              <span className="mono">{sealed ? ".env.coffer" : ".env"}</span>
              <span className={`stamp ${sealed ? "on" : ""}`}>{sealed ? "Sealed" : phase === "opened" ? "Opened" : "Plain text"}</span>
            </div>
            <pre className="stage-lines" aria-live="off">{shown.map((l, i) => <span key={i}>{l || " "}{"\n"}</span>)}</pre>
            <div className="stage-meta mono">{bytes ? `${bytes.toLocaleString("en")} bytes sealed just now` : " "}</div>
          </div>
          <ul className="stage-readers">
            <li className={`rd rd-${readerState}`}>
              <span className="rd-key" aria-hidden />
              <span>Reader who stays</span>
              <span className="rd-state">{readerState === "open" ? "Opens it" : readerState === "keep" ? "Can open" : "Not shared yet"}</span>
            </li>
            <li className={`rd rd-${removedState}`}>
              <span className="rd-key" aria-hidden />
              <span>Removed reader</span>
              <span className="rd-state">{removedState === "refused" ? "Refused" : removedState === "gone" ? "Removed" : removedState === "keep" ? "Can open" : "Not shared yet"}</span>
            </li>
          </ul>
          <figcaption>
            <span className="cap">{CAPTION[phase]}</span>
            <span className="live mono">
              {live === "live" ? <><span className="dot dot-open" /> Running live in your browser: real ML-KEM-1024, fresh keys each loop</> :
                live === "failed" ? "The live demo stopped: this browser could not run the sealing code." : "Loading the sealing code"}
            </span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
