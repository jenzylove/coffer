// The hero: a glass seal in a cool studio. Every state it shows comes from the
// real sealing code running in this browser, with fresh ML-KEM-1024 keys each loop:
// sealed to two readers, sealed again for one, the one who stays opens it, the
// removed one is refused.
import { useEffect, useRef, useState } from "react";
import type { Glass } from "./glass.ts";

const PLAIN = [
  "OPENAI_API_KEY=sk-proj-••••••••",
  "DATABASE_URL=postgres://app:••••@db/main",
  "STRIPE_SECRET_KEY=sk_live_••••••",
];

type Phase = "loading" | "plain" | "sealed" | "revoked" | "opened" | "refused" | "failed";
const HOLD: Record<string, number> = { plain: 2200, sealed: 2600, revoked: 2400, opened: 3400, refused: 3000 };
const CAPTION: Record<Phase, string> = {
  loading: "Loading the sealing code",
  plain: "A plain .env",
  sealed: "Sealed to two readers",
  revoked: "One reader removed, sealed again",
  opened: "The reader who stays opens it",
  refused: "The removed reader is refused",
  failed: "The live demo stopped: this browser could not run the sealing code",
};

export function Hero() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const glass = useRef<Glass | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [gl, setGl] = useState<"pending" | "on" | "off">("pending");

  useEffect(() => {
    let off = false;
    import("./glass.ts").then(({ createGlass }) => {
      if (off || !canvas.current) return;
      glass.current = createGlass(canvas.current);
      setGl(glass.current ? "on" : "off");
    }).catch(() => setGl("off"));
    return () => { off = true; glass.current?.dispose(); glass.current = null; };
  }, []);

  useEffect(() => {
    if (gl === "pending") return;
    let stop = false;
    (async () => {
      let qs: typeof import("@qorechain/qoreseal");
      try { qs = await import("@qorechain/qoreseal"); } catch { setPhase("failed"); return; }
      await document.fonts?.ready;
      const enc = new TextEncoder(), dec = new TextDecoder();
      const plaintext = enc.encode(PLAIN.join("\n"));
      const ctx = { chainId: "qorechain-diana", purpose: "coffer:hero" };
      const cipher = (env: Uint8Array) => {
        const b = qs.toBase64Url(env.slice(-60));
        return [b.slice(0, 18), b.slice(18, 36), b.slice(36, 54)];
      };
      // ?slow stretches how long each real state is held (for slow machines and screen captures)
      const stretch = new URLSearchParams(location.search).has("slow") ? 4 : 1;
      const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms * stretch));
      while (!stop) {
        const reader = qs.generateSealKeys(), removed = qs.generateSealKeys();
        setPhase("plain"); glass.current?.plain(PLAIN);
        await wait(HOLD.plain!); if (stop) return;

        let env = qs.seal({ ...ctx, mode: "mlkem", plaintext, recipients: [{ mlkemPublicKey: reader.mlkemPublicKey }, { mlkemPublicKey: removed.mlkemPublicKey }] });
        setPhase("sealed"); glass.current?.seal(cipher(env));
        await wait(HOLD.sealed!); if (stop) return;

        env = qs.seal({ ...ctx, mode: "mlkem", plaintext, recipients: [{ mlkemPublicKey: reader.mlkemPublicKey }] });
        setPhase("revoked"); glass.current?.seal(cipher(env));
        await wait(HOLD.revoked!); if (stop) return;

        const names = dec.decode(qs.open({ ...ctx, envelope: env, keys: reader })).split("\n").map((l) => l.split("=")[0] ?? "");
        setPhase("opened"); glass.current?.open(names);
        await wait(HOLD.opened!); if (stop) return;

        try {
          qs.open({ ...ctx, envelope: env, keys: removed });
          setPhase("failed"); return; // never fake a refusal
        } catch (e) {
          if (!qs.isQoreSealError(e, "NOT_A_RECIPIENT")) { setPhase("failed"); return; }
        }
        setPhase("refused"); glass.current?.refuse();
        await wait(HOLD.refused!);
      }
    })();
    return () => { stop = true; };
  }, [gl]);

  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="studio" aria-hidden />
      <div className="screen">
        <canvas ref={canvas} className="screen-canvas" aria-hidden />
        {gl === "off" && <div className="seal-fallback" aria-hidden><span /></div>}
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
