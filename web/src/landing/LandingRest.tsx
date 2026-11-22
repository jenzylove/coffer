// Everything below the hero: loaded after the first paint, then rendered one
// section per idle slot so no single task blocks the page.
import { startTransition, useEffect, useState, type ReactNode } from "react";
import { Reveal } from "../components/Chrome.tsx";
import { Sheet, Tag } from "../components/Doc.tsx";
import { Link } from "../lib/router.tsx";
import { Story } from "./Story.tsx";
import { ScanDoor } from "./ScanDoor.tsx";

const FOUND = 2284, ENCRYPTED = 1716;

const WHY: { q: string; a: string }[] = [
  { q: "Every address has a public sealing key on chain.", a: "So you can lock a file to a teammate knowing only their address. No key swapping, no invite links." },
  { q: "Every change is signed with a quantum safe key.", a: "The owner signs who can read and the last writer signs what was written, with ML-DSA-87 keys registered on QoreChain." },
  { q: "Every share and revoke is recorded, so old copies are refused.", a: "Before opening, Coffer reads the record. A copy restored from before a revoke is refused." },
];

const SAFETY: { q: string; a: string }[] = [
  { q: "No server sees your values", a: "Sealing and opening happen in your terminal or this browser. The Coffer server relays to QoreChain and pays setup fees; it never receives your values. One exception: a file you share with the demo teammate is opened by that teammate on the server, which reports names only." },
  { q: "A signature proves who, not whether you know them", a: "Anyone can make a valid Coffer file sealed to your address. The CLI remembers each file's owner the first time and refuses a copy from someone else. In the browser, check the owner shown before you use a file." },
  { q: "Keys come from a QoreChain node", a: "Reader keys, signing keys and records are read from a QoreChain REST node, through the Coffer server in the browser. The CLI can use your own node with COFFER_REST." },
  { q: "Your recovery phrase opens everything shared with you", a: "It is the one secret to keep, like dotenvx's .env.keys. On a server, put it in COFFER_IDENTITY. The web app keeps it in this browser until you remove it." },
  { q: "Revoking can't take back what someone already read", a: "A removed reader can't open the new file, but may remember old values. Coffer lists every name so you can rotate them." },
  { q: "Testnet only, for now", a: "Coffer runs on QoreChain testnet; test QOR has no value. Mainnet waits until the key registry is exercised there end to end." },
];

const FAQ: { q: string; a: string }[] = [
  { q: "Is a .env.coffer file really safe in a public repo?", a: "The values are encrypted with AES 256 and the key is sealed with ML-KEM-1024 to each reader. The file shows its owner and readers' addresses; everything else, key names included, is sealed." },
  { q: "What does a quantum computer change?", a: "It breaks the curves most tools use today, secp256k1 included. Public repos are kept forever, so those files can be collected now and opened later. ML-KEM-1024 (FIPS 203) is built to resist that." },
  { q: "Do my teammates need a crypto wallet?", a: "No. Coffer makes an address from a 24 word recovery phrase, in the CLI or this browser, and the relayer pays the setup." },
  { q: "How do I move from dotenvx?", a: "Run coffer import next to your .env and .env.keys, or use the app. Values are decrypted on your machine and sealed again. Rotate them when you can, since old copies stay in git history." },
  { q: "What if I lose my recovery phrase?", a: "You can't open files shared with that address any more. Make a new one and ask the owner to share with it." },
];

function Rows({ items, first = false }: { items: { q: string; a: string }[]; first?: boolean }) {
  return (
    <div className="rows">
      {items.map((f, i) => (
        <details key={f.q} open={first && i === 0}>
          <summary>{f.q}</summary>
          <p>{f.a}</p>
        </details>
      ))}
    </div>
  );
}

const SECTIONS: (() => ReactNode)[] = [
  () => (
    <section className="block" id="problem" aria-labelledby="h-problem">
      <div className="wrap split">
        <Reveal>
          <h2 id="h-problem" className="h-section">Encrypted today. Readable later.</h2>
          <p className="lead">dotenvx lets teams commit encrypted .env files, locked with a curve a quantum computer breaks. Public repos are copied and kept forever.</p>
        </Reveal>
        <Reveal className="problem-doc">
          <Sheet left=".env, committed with dotenvx" right="format example">
            <div className="env-line"><span className="env-k">DOTENV_PUBLIC_KEY=</span><span className="dim">"02b4e1…c9a7"</span></div>
            <div className="env-line"><span className="env-k">DATABASE_URL=</span><span className="dim">"encrypted:BNx4…"</span></div>
            <div className="env-line"><span className="env-k">OPENAI_API_KEY=</span><span className="dim">"encrypted:BKq9…"</span></div>
            <div className="sheet-foot"><Tag>secp256k1: a quantum computer opens this</Tag></div>
          </Sheet>
          <div className="count">
            <p className="count-n">{ENCRYPTED.toLocaleString("en")}</p>
            <p className="count-l">public GitHub files like this one, 17 Nov 2026</p>
            <p className="mono small dim">GitHub code search: DOTENV_PUBLIC_KEY encrypted:</p>
            <details className="mini">
              <summary>How we counted</summary>
              <p>Two GitHub code searches on 17 November 2026. <span className="mono">DOTENV_PUBLIC_KEY</span> finds {FOUND.toLocaleString("en")} files that carry a dotenvx key; <span className="mono">DOTENV_PUBLIC_KEY encrypted:</span> finds the {ENCRYPTED.toLocaleString("en")} of them that hold encrypted values. Counts are approximate and cover indexed default branches only. The file above is an illustration of the format, not one of them.</p>
            </details>
          </div>
        </Reveal>
      </div>
    </section>
  ),
  () => (
    <section className="block block-story" id="how" aria-labelledby="h-how">
      <div className="wrap">
        <Reveal className="story-head">
          <h2 id="h-how" className="h-section">How it works.</h2>
          <p className="lead">Five steps. The document on the right is computed in your browser as you reach each one.</p>
        </Reveal>
      </div>
      <Story />
    </section>
  ),
  () => (
    <section className="block" id="scan" aria-labelledby="h-scan">
      <div className="wrap">
        <Reveal>
          <h2 id="h-scan" className="h-section">Is your repo already leaking?</h2>
          <p className="lead">Paste a public repo. We list every env file in it and say who can read it.</p>
        </Reveal>
        <Reveal><ScanDoor /></Reveal>
      </div>
    </section>
  ),
  () => (
    <section className="block" id="qorechain" aria-labelledby="h-why">
      <div className="wrap split">
        <Reveal><h2 id="h-why" className="h-section">Why QoreChain.</h2><p className="lead">An address is enough, because the chain holds everyone's public keys and every record.</p></Reveal>
        <Reveal as="ol" className="why">
          {WHY.map((w, i) => (
            <li key={w.q}>
              <span className="mono why-n">{String(i + 1).padStart(2, "0")}</span>
              <span className="why-body"><strong>{w.q}</strong><span>{w.a}</span></span>
            </li>
          ))}
        </Reveal>
      </div>
    </section>
  ),
  () => (
    <section className="block" id="safety" aria-labelledby="h-safety">
      <div className="wrap split">
        <Reveal><h2 id="h-safety" className="h-section">Safety, in plain words.</h2></Reveal>
        <Reveal><Rows items={SAFETY} first /></Reveal>
      </div>
    </section>
  ),
  () => (
    <section className="block" id="faq" aria-labelledby="h-faq">
      <div className="wrap split">
        <Reveal><h2 id="h-faq" className="h-section">Questions.</h2></Reveal>
        <Reveal><Rows items={FAQ} first /></Reveal>
      </div>
    </section>
  ),
  () => (
    <section className="block closing" aria-labelledby="h-close">
      <div className="wrap">
        <Reveal>
          <h2 id="h-close" className="h-display closing-t">Seal your first file in a minute.</h2>
          <p className="lead">Make an address, seal a .env, share it with our demo teammate, then take it back.</p>
          <div className="actions"><Link to="/app" className="btn">Open the app</Link></div>
        </Reveal>
      </div>
    </section>
  ),
];

export default function LandingRest() {
  const [n, setN] = useState(() => (location.hash ? SECTIONS.length : 1));
  useEffect(() => {
    if (n >= SECTIONS.length) return;
    const w = window as any;
    const next = () => startTransition(() => setN((x) => x + 1));
    // cancel only the kind of handle we made: clearTimeout on an idle id can kill an unrelated timer
    const idle = !!w.requestIdleCallback;
    const h = idle ? w.requestIdleCallback(next, { timeout: 600 }) : setTimeout(next, 80);
    return () => { if (idle) w.cancelIdleCallback(h); else clearTimeout(h); };
  }, [n]);
  return <>{SECTIONS.slice(0, n).map((render, i) => <div key={i}>{render()}</div>)}</>;
}
