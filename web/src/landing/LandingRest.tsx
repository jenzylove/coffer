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
  { q: "Each teammate signs one card, and QoreChain checks it.", a: "A wallet like QoreX can't publish an encryption key by itself. So your teammate signs one short card that says which keys to seal to, with no fee. The Coffer contract on QoreChain checks that signature against their quantum safe key on chain and keeps their newest card. From then on you seal to them knowing only their address." },
  { q: "Every change is signed with a quantum safe key.", a: "When you share with someone or remove them, you approve one change in QoreX. It carries an ML-DSA-87 signature, and QoreChain checks it before it records anything." },
  { q: "Every change is recorded, so old copies are refused.", a: "The Coffer contract keeps each file's latest change and only lets it move forward. Before opening, Coffer compares the file with that record. A copy from before someone was removed is refused by what the chain says, not by our app." },
];

const SAFETY: { q: string; a: string }[] = [
  { q: "No server sees your values", a: "Sealing and opening happen in your terminal or this browser. The Coffer server passes signed cards and changes to QoreChain and pays the gas; it can't forge either, and it never receives your values. One exception: a file you share with Ada, the demo teammate, is opened by Ada on the server, which reports names only." },
  { q: "A signature proves who, not whether you know them", a: "Anyone can make a valid Coffer file sealed to your address. The CLI remembers each file's owner the first time and refuses a copy from someone else. In the browser, check the owner shown before you use a file." },
  { q: "Keys come from QoreChain", a: "Cards, signing keys and file records are read from QoreChain, through the Coffer server in the browser. The CLI can use your own node with COFFER_REST." },
  { q: "Your key file opens everything shared with you", a: "The key that opens your files lives in this browser or your terminal. Save my key file keeps a private copy, like dotenvx's .env.keys. Keep it private and never commit it." },
  { q: "Removing someone can't take back what they already read", a: "A removed reader can't open the new version, but may remember old values. Coffer lists every name so you can change them at the provider." },
  { q: "Testnet only, for now", a: "Coffer runs on QoreChain testnet; test QOR has no value. Mainnet waits until the key registry is exercised there end to end." },
];

const FAQ: { q: string; a: string }[] = [
  { q: "Is a .env.coffer file really safe in a public repo?", a: "The values are encrypted with AES 256, and that key is sealed to each reader with ML-KEM-1024 and X25519 together. The file shows the addresses of its owner and readers; everything else, key names included, is sealed." },
  { q: "What does a quantum computer change?", a: "It breaks the curves most tools use today, secp256k1 included. Public repos are kept forever, so those files can be collected now and opened later. ML-KEM-1024 (FIPS 203) is built to resist that." },
  { q: "Do my teammates need a crypto wallet?", a: "QoreX is the easy way: connect it and sign once, with no fee. No QoreX? Coffer can keep a key in the browser or the CLI instead, and the Coffer relayer pays its setup." },
  { q: "How do I move from dotenvx?", a: "Run coffer import next to your .env and .env.keys, or use the app. Values are decrypted on your machine and sealed again. Rotate them when you can, since old copies stay in git history." },
  { q: "What if I lose my key?", a: "Load your key file to get it back. No key file? Make a new key, and the owner seals you in again with one click." },
  { q: "What does QoreChain refuse?", a: "A forged card. A card older than the one it already has. A change to a file signed by anyone but its owner. And any older copy of a file, once a newer change is recorded." },
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
        <Reveal><h2 id="h-why" className="h-section">Why QoreChain.</h2><p className="lead">An address is enough, because the chain holds everyone's card and every file's latest change.</p></Reveal>
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
          <p className="lead">Connect QoreX, seal a .env, share it with Ada, our demo teammate, then take it back.</p>
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
