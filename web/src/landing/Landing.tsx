import { CopyButton, Page, Reveal } from "../components/Chrome.tsx";
import { Link } from "../lib/router.tsx";
import { Hero } from "./Hero.tsx";
import { LocalDemo } from "./LocalDemo.tsx";
import { ScanDoor } from "./ScanDoor.tsx";

const FOUND = 2284, ENCRYPTED = 1716;

function Head({ n, title, sub }: { n: string; title: string; sub?: string }) {
  return (
    <Reveal className="shead">
      <span className="shead-n">{n}</span>
      <h2>{title}</h2>
      {sub && <p className="shead-sub">{sub}</p>}
    </Reveal>
  );
}

const CLI: { show: string; copy: string; note: string }[] = [
  { show: "coffer init", copy: "npx github:jenzylove/coffer init", note: "make your address" },
  { show: "coffer lock", copy: "npx github:jenzylove/coffer lock", note: "seal .env into .env.coffer" },
  { show: "coffer share qor1…", copy: "npx github:jenzylove/coffer share ", note: "add a reader" },
  { show: "coffer revoke qor1…", copy: "npx github:jenzylove/coffer revoke ", note: "remove one, list what to rotate" },
  { show: "coffer run -- npm start", copy: "npx github:jenzylove/coffer run -- npm start", note: "secrets in memory only" },
  { show: "coffer import", copy: "npx github:jenzylove/coffer import", note: "move a dotenvx file over" },
];

const CHAIN: { q: string; a: string }[] = [
  { q: "A public registry of sealing keys", a: "Every QoreChain account can publish an ML-KEM-1024 key, signed by its own ML-DSA key. That is what lets you seal to someone knowing only their address." },
  { q: "Two signatures on every file", a: "The owner signs who can read; the last writer signs what was written. Readers check both against keys on chain, so a hand edited reader list is refused." },
  { q: "A record of every share and revoke", a: "Each change is a small signed transaction. Before opening, Coffer reads it, so an old copy restored after a revoke is refused." },
  { q: "What it costs", a: "Setup is 0.054 test QOR once per person, paid by the Coffer relayer. Each share or revoke record is about 0.017." },
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
    <Reveal className="rows">
      {items.map((f, i) => (
        <details key={f.q} open={first && i === 0}>
          <summary>{f.q}</summary>
          <p>{f.a}</p>
        </details>
      ))}
    </Reveal>
  );
}

export function Landing() {
  return (
    <Page>
      <Hero />
      <section className="doorbar" aria-label="Scan a repo"><div className="wrap"><ScanDoor /></div></section>

      <section className="sect" id="problem">
        <div className="wrap">
          <Head n="01" title="Encrypted today. Readable later." />
          <Reveal className="count">
            <p className="count-n">{ENCRYPTED.toLocaleString("en")}</p>
            <p className="count-l">public files on GitHub hold dotenvx values locked with secp256k1, a curve a quantum computer breaks. Repos are copied forever.</p>
            <div className="bar" role="img" aria-label={`${ENCRYPTED} of ${FOUND} dotenvx files hold encrypted values`}><span style={{ width: `${(ENCRYPTED / FOUND) * 100}%` }} /></div>
            <p className="count-of">{ENCRYPTED.toLocaleString("en")} of {FOUND.toLocaleString("en")} files that carry a dotenvx key</p>
            <details className="method">
              <summary>How we counted</summary>
              <p>GitHub code search on 17 November 2026. Queries: <code>DOTENV_PUBLIC_KEY</code> and <code>DOTENV_PUBLIC_KEY encrypted:</code>. Counts are approximate and cover indexed default branches only.</p>
            </details>
          </Reveal>
        </div>
      </section>

      <section className="sect" id="how">
        <div className="wrap">
          <Head n="02" title="Seal. Share. Revoke. Run." sub="Try it here. This runs Coffer's own code in your browser with three throwaway identities." />
          <Reveal><LocalDemo /></Reveal>
        </div>
      </section>

      <section className="sect" id="cli">
        <div className="wrap">
          <Head n="03" title="Six commands in your terminal." />
          <Reveal className="term" aria-label="Coffer commands">
            <div className="term-bar" aria-hidden><span /><span /><span /></div>
            <ul>
              {CLI.map((c) => (
                <li key={c.show}>
                  <code><span className="term-p" aria-hidden>$</span>{c.show}</code>
                  <span className="term-note">{c.note}</span>
                  <CopyButton text={c.copy} />
                </li>
              ))}
            </ul>
            <p className="term-foot">Copy adds <code>npx github:jenzylove/coffer</code>: runs straight from GitHub, nothing to install.</p>
          </Reveal>
        </div>
      </section>

      <section className="sect" id="qorechain">
        <div className="wrap">
          <Head n="04" title="An address is enough." sub="QoreChain holds everyone's public sealing key, so sharing is typing an address." />
          <Reveal className="chainflow" aria-label="How sharing by address works">
            <span className="cf-node"><span className="cf-dot" />Teammate's address</span>
            <span className="cf-line" aria-hidden />
            <span className="cf-node"><span className="cf-dot cf-blue" />Their key on QoreChain</span>
            <span className="cf-line" aria-hidden />
            <span className="cf-node cf-sealed"><span className="cf-disc" />Sealed to them</span>
          </Reveal>
          <Rows items={CHAIN} />
        </div>
      </section>

      <section className="sect" id="safety">
        <div className="wrap">
          <Head n="05" title="What it protects, and what it can't." />
          <Rows items={SAFETY} />
        </div>
      </section>

      <section className="sect" id="faq">
        <div className="wrap">
          <Head n="06" title="Questions." />
          <Rows items={FAQ} first />
        </div>
      </section>

      <section className="closing">
        <div className="wrap closing-in">
          <Reveal>
            <div className="mini-seal" aria-hidden />
            <h2>Seal your first file in a minute.</h2>
            <p>Share it with our demo teammate, take it back, watch them get refused.</p>
            <div className="closing-cta">
              <Link to="/app" className="btn btn-primary btn-big">Open the app</Link>
              <Link to="/proof" className="btn btn-ghost btn-big">See the proof</Link>
            </div>
          </Reveal>
        </div>
      </section>
    </Page>
  );
}
