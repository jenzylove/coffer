import { CopyButton, Page, Reveal } from "../components/Chrome.tsx";
import { Link } from "../lib/router.tsx";
import { Hero } from "./Hero.tsx";
import { LocalDemo } from "./LocalDemo.tsx";

const FOUND = 2284, ENCRYPTED = 1716;

function SectionHead({ n, kicker, title }: { n: string; kicker: string; title: string }) {
  return (
    <Reveal className="shead">
      <span className="shead-n mono">{n}</span>
      <p className="shead-k">{kicker}</p>
      <h2 className="display">{title}</h2>
    </Reveal>
  );
}

const CLI: { show: string; copy: string; what: string }[] = [
  { show: "npx github:jenzylove/coffer init", copy: "npx github:jenzylove/coffer init", what: "Make your address and publish your keys on QoreChain. The relayer pays the setup." },
  { show: "npx github:jenzylove/coffer lock", copy: "npx github:jenzylove/coffer lock", what: "Seal .env into .env.coffer. Commit that file; keep .env out of git." },
  { show: "npx github:jenzylove/coffer share qor1…", copy: "npx github:jenzylove/coffer share ", what: "Add a reader by their address. A new key, sealed to them, recorded on chain." },
  { show: "npx github:jenzylove/coffer revoke qor1…", copy: "npx github:jenzylove/coffer revoke ", what: "Remove a reader. Prints the names to rotate at each provider." },
  { show: "npx github:jenzylove/coffer run -- npm start", copy: "npx github:jenzylove/coffer run -- npm start", what: "Start your app with the secrets in its environment only. Nothing is written to disk." },
  { show: "npx github:jenzylove/coffer import", copy: "npx github:jenzylove/coffer import", what: "Move a dotenvx .env over, using its .env.keys, decrypted on your machine." },
];

const FAQ: { q: string; a: string }[] = [
  { q: "Is a .env.coffer file really safe in a public repo?", a: "Its values are encrypted with AES 256, and the key to them is sealed with ML-KEM-1024 to each reader's public key. Without a reader's recovery phrase there is nothing to open it with. The file shows its owner and its readers' addresses. Everything else, key names included, is inside the sealed part." },
  { q: "What does a quantum computer change?", a: "A large enough quantum computer breaks the elliptic curves most encryption tools use today, secp256k1 included. Files committed to public repos are copied and kept forever, so anything sealed with those curves can be collected now and opened later. ML-KEM-1024 is the NIST standard (FIPS 203) built to stay safe against that." },
  { q: "Do my teammates need a crypto wallet?", a: "No. Coffer makes an address from a 24 word recovery phrase, in the CLI or in this browser. Setup takes two small transactions on QoreChain testnet, and the Coffer relayer pays for them." },
  { q: "How do I move from dotenvx?", a: "Run the import command next to your .env and .env.keys, or use the web app. The values are decrypted on your machine and sealed again with Coffer. The old copies stay in your git history, so rotate the values when you can." },
  { q: "What if I lose my recovery phrase?", a: "You can no longer open files shared with that address. Make a new address and ask the file's owner to share with it. If you were the owner, a reader can seal the values into a new file you own." },
  { q: "Does Coffer keep my secrets on a server?", a: "No. Sealing and opening happen in your terminal or your browser. The Coffer server only relays requests to QoreChain, pays the setup fee, and runs the demo teammate, which sees key names and never values." },
  { q: "Which network does it run on?", a: "QoreChain testnet, named qorechain-diana. Test QOR has no value. Mainnet comes once QoreChain's key registry has been exercised there end to end." },
];

export function Landing() {
  return (
    <Page>
      <Hero />

      <section className="sect" id="problem" aria-labelledby="h-problem">
        <div className="wrap">
          <SectionHead n="01" kicker="The problem" title="The popular way to commit secrets can be opened later." />
          <div className="cols">
            <Reveal className="col-text">
              <p className="big">dotenvx lets teams commit encrypted <code>.env</code> files. It encrypts them with secp256k1, the curve behind Bitcoin keys, and a large enough quantum computer breaks that curve.</p>
              <p>Public repos are copied and mirrored forever. Anyone can collect these files today and open them the day that computer exists. Rotating keys later does not help a file that already leaked its old values.</p>
            </Reveal>
            <Reveal className="col-fig" delay={120}>
              <figure className="count" aria-labelledby="h-problem-fig">
                <p className="count-n display">{FOUND.toLocaleString("en")}</p>
                <p id="h-problem-fig" className="count-l">public files on GitHub carry a dotenvx public key</p>
                <div className="bar" role="img" aria-label={`${ENCRYPTED.toLocaleString("en")} of ${FOUND.toLocaleString("en")} also hold encrypted values`}>
                  <span style={{ width: `${(ENCRYPTED / FOUND) * 100}%` }} />
                </div>
                <p className="count-l"><strong className="t-seal">{ENCRYPTED.toLocaleString("en")}</strong> of them also hold encrypted values that a quantum computer could open.</p>
                <details className="method">
                  <summary>How we counted</summary>
                  <p>GitHub code search, run on 17 November 2026. First query: <code>DOTENV_PUBLIC_KEY</code>. Second query: <code>DOTENV_PUBLIC_KEY encrypted:</code>. Code search counts are approximate and cover only indexed default branches.</p>
                </details>
              </figure>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="sect" id="how" aria-labelledby="h-how">
        <div className="wrap">
          <SectionHead n="02" kicker="How it works" title="Seal it, share it by address, take it back, run it." />
          <Reveal><p className="sect-lede">Try the real thing. The steps below run Coffer's own sealing code in your browser, with three throwaway identities made on this page.</p></Reveal>
          <Reveal><LocalDemo /></Reveal>
        </div>
      </section>

      <section className="sect" id="cli" aria-labelledby="h-cli">
        <div className="wrap">
          <SectionHead n="03" kicker="The CLI" title="Six commands. Your repo stays the source of truth." />
          <Reveal as="ul" className="cli">
            {CLI.map((c) => (
              <li key={c.show}>
                <code className="cli-cmd"><span className="cli-p" aria-hidden>$</span>{c.show}</code>
                <span className="cli-what">{c.what}</span>
                <CopyButton text={c.copy} />
              </li>
            ))}
          </Reveal>
        </div>
      </section>

      <section className="sect" id="qorechain" aria-labelledby="h-qore">
        <div className="wrap">
          <SectionHead n="04" kicker="What QoreChain does here" title="An address is enough, because the chain holds the keys." />
          <div className="rules">
            <Reveal className="rule-row">
              <h3>A public registry of ML-KEM keys</h3>
              <p>Every QoreChain account can publish an ML-KEM-1024 public key, signed by its own ML-DSA key. That registry is what lets you seal a file to someone knowing only their <code>qor1</code> address. Without it you would swap public keys by hand.</p>
            </Reveal>
            <Reveal className="rule-row">
              <h3>Two signatures on every file</h3>
              <p>The owner signs who can read. Whoever last wrote the values signs what they wrote. Both use ML-DSA-87 keys registered to their accounts, so a reader checks them against the chain, not against the file. Edit a reader list by hand and the file is refused.</p>
            </Reveal>
            <Reveal className="rule-row">
              <h3>A record of every share and revoke</h3>
              <p>Each change of readers is a small signed transaction with a memo naming the file and its new version. Before opening, Coffer reads that record, so an old copy restored after a revoke is refused.</p>
            </Reveal>
            <Reveal className="rule-row">
              <h3>What it costs</h3>
              <p>Setting up an address takes two transactions, 0.054 test QOR, once per person, and the Coffer relayer pays it. Each share or revoke record costs about 0.017 test QOR.</p>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="sect" id="safety" aria-labelledby="h-safety">
        <div className="wrap">
          <SectionHead n="05" kicker="Safety, in plain words" title="What Coffer protects, and what it can't." />
          <div className="rules">
            <Reveal className="rule-row">
              <h3>No server sees your values</h3>
              <p>Sealing and opening happen in your terminal or in this browser. The Coffer server relays requests to QoreChain and pays setup fees; it never receives your values. The one exception is a file you share with the demo teammate: that reader runs on the server and opens it like any reader would, then reports only the names.</p>
            </Reveal>
            <Reveal className="rule-row">
              <h3>A signature proves who, not whether you know them</h3>
              <p>Anyone can make a valid Coffer file and seal it to your address. The CLI remembers who owned each file the first time you open it and refuses a copy from a different owner, so a swapped file can't trick you into running its values or sealing new ones to a stranger. In the browser, check the owner shown before you use a file.</p>
            </Reveal>
            <Reveal className="rule-row">
              <h3>Keys come from a QoreChain node</h3>
              <p>Reader keys, signing keys and records are read from a QoreChain REST node, through the Coffer server in the browser. The CLI can point at your own node with <code>COFFER_REST</code>.</p>
            </Reveal>
            <Reveal className="rule-row">
              <h3>Your recovery phrase opens everything shared with you</h3>
              <p>It is the one secret to protect, like dotenvx's <code>.env.keys</code> file. On a server, put it in <code>COFFER_IDENTITY</code>. The web app keeps it in this browser's storage until you remove it.</p>
            </Reveal>
            <Reveal className="rule-row">
              <h3>Revoking can't take back what someone already read</h3>
              <p>A removed reader can't open the new file, but they may remember the old values. Coffer lists every name in the file so you can rotate them at the provider.</p>
            </Reveal>
            <Reveal className="rule-row">
              <h3>Testnet only, for now</h3>
              <p>Coffer runs on QoreChain testnet. Test QOR has no value. Mainnet waits until QoreChain's key registry is exercised there end to end.</p>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="sect" id="faq" aria-labelledby="h-faq">
        <div className="wrap">
          <SectionHead n="06" kicker="Questions" title="Asked before you commit." />
          <Reveal className="faq">
            {FAQ.map((f, i) => (
              <details key={f.q} open={i === 0}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </Reveal>
        </div>
      </section>

      <section className="closing" aria-labelledby="h-close">
        <div className="wrap closing-in">
          <Reveal>
            <h2 id="h-close" className="display closing-t">Seal your first file in a minute.</h2>
            <p className="lede">Make an address in your browser, seal a <code>.env</code>, share it with our demo teammate, then take it back and watch them get refused.</p>
            <div className="closing-cta">
              <Link to="/app" className="btn btn-seal btn-big">Open the app</Link>
              <Link to="/proof" className="btn btn-line btn-big">See the proof</Link>
            </div>
          </Reveal>
        </div>
      </section>
    </Page>
  );
}
