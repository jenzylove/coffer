// /proof: what is real and how to inspect it. Live numbers are read now; recorded
// ones come from the repo's build log and spike, with their dates.
import { useEffect, useState } from "react";
import { Page, Reveal } from "../components/Chrome.tsx";
import { api, qor, short, txUrl } from "../lib/net.ts";

interface Stats { relayer: { address: string; uqor: number | string }; drips24h: number; teammate: string | { address: string } }

const RUN: { step: string; result: string; tx?: string }[] = [
  { step: "Owner seals a .env and records the new file", result: "Done", tx: "FE210BDF968E360D03D7F952410A4C3029486030F19F3B807C90A3A89B595919" },
  { step: "Owner shares with readers B and C", result: "Both run their app with the secrets", tx: "AEBA0CF76C741934A6FB4D70C5022007E5A3D4325A06F059D3A762886B6F4060" },
  { step: "Owner revokes C", result: "B still runs; C gets \"not a reader\"", tx: "47DECAD5A58F4EFCA31C28EE12083F2A2F661D423390A446C7A160E36AAFCBAE" },
  { step: "The copy from before the revoke is restored on a fresh machine", result: "Refused: the chain record shows a later epoch" },
  { step: "The reader list is edited by hand", result: "Refused: the owner's signature fails" },
  { step: "Plain text left on disk after every step", result: "None besides the original .env" },
];

const SETUP: { who: string; mldsa: string; kem: string }[] = [
  { who: "A, owner", mldsa: "BF50E7F789BC7F20D60B4BFB4CEF1C715222CAE08A6E0C4EB1A4B3967E82FAC4", kem: "7FEA6E38D9371DF260B8D15C1DB9C21D85221FECC5A40CD0EBD78DD28B58B2EB" },
  { who: "B, reader kept", mldsa: "1BECDFF311C6A0F00F5EB3DA8C16BBB57A98AD8A019280C4AE109E7A4049D522", kem: "BEF9259C56672C03DB2AA9C471B262F31B39F5FCD5AA745FBD2F973B9064B95B" },
  { who: "C, reader revoked", mldsa: "68ED75AFC3A3379FAE1EE867C8C3ACD31CBEC513A8E027D821A7E868443D04A0", kem: "A1B6DFB7293566CA0E431D114515027BA5331468E570EC4104922D770E66F8BE" },
];

const Tx = ({ h }: { h: string }) => <a className="mono txlink" href={txUrl(h)} target="_blank" rel="noreferrer" title={h}>{short(h, 10, 8)}</a>;

function Live() {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  useEffect(() => {
    api<Stats>("/api/stats").then((x) => { setS(x); setAt(new Date()); }).catch((e) => setErr((e as Error).message));
  }, []);
  const mate = s ? (typeof s.teammate === "string" ? s.teammate : s.teammate?.address) : null;
  return (
    <div className="proof-live">
      <p className="badge badge-live"><span className="dot dot-open" /> Live{at ? `, read at ${at.toLocaleTimeString()}` : ""}</p>
      {err ? <p className="msg msg-err">Live stats are not available: {err}</p> : !s ? <p className="muted">Reading the Coffer server…</p> : (
        <dl className="facts facts-big">
          <div><dt>Relayer balance</dt><dd className="mono">{qor(BigInt(s.relayer.uqor))} QOR</dd></div>
          <div><dt>Addresses funded in the last 24 hours</dt><dd className="mono">{s.drips24h}</dd></div>
          <div><dt>Relayer address</dt><dd className="mono">{short(s.relayer.address, 12, 6)}</dd></div>
          {mate && <div><dt>Demo teammate</dt><dd className="mono">{short(mate, 12, 6)}</dd></div>}
        </dl>
      )}
    </div>
  );
}

export default function Proof() {
  return (
    <Page>
      <div className="wrap proof">
        <header className="proof-head">
          <p className="eyebrow">Proof</p>
          <h1 className="display app-title">What is real, and how to check it yourself.</h1>
          <p className="lede">Every number here is either read live from the Coffer server and QoreChain, or recorded from a run on QoreChain testnet with a transaction you can open. Each one says which.</p>
        </header>

        <div className="proof-body">
        <Reveal as="section" className="psect">
          <h2 className="psect-t"><span className="shead-n">01</span>The exposure</h2>
          <p className="badge">Recorded on 17 November 2026</p>
          <div className="pnums">
            <div><p className="count-n">2,284</p><p>public files on GitHub contain <code>DOTENV_PUBLIC_KEY</code>, the mark of a dotenvx encrypted file.</p></div>
            <div><p className="count-n">1,716</p><p>of those also contain <code>encrypted:</code> values, locked with secp256k1.</p></div>
          </div>
          <details className="method" open>
            <summary>Method</summary>
            <p>GitHub code search, 17 November 2026. Query one: <code>DOTENV_PUBLIC_KEY</code>. Query two: <code>DOTENV_PUBLIC_KEY encrypted:</code>. GitHub's code search counts are approximate and only cover indexed default branches.</p>
          </details>
        </Reveal>

        <Reveal as="section" className="psect">
          <h2 className="psect-t"><span className="shead-n">02</span>A three person team on testnet</h2>
          <p className="badge">Recorded on 17 November 2026, through the real CLI</p>
          <ol className="prun">
            {RUN.map((r) => (
              <li key={r.step}>
                <span className="prun-step">{r.step}</span>
                <span className={`prun-res ${r.result.startsWith("Refused") || r.result.includes("not a reader") ? "t-seal" : ""}`}>{r.result}</span>
                {r.tx ? <Tx h={r.tx} /> : <span className="muted small">no transaction</span>}
              </li>
            ))}
          </ol>
          <details className="method">
            <summary>The six setup transactions (each reader registers two keys once)</summary>
            <ol className="prun">
              {SETUP.map((s) => (
                <li key={s.who}>
                  <span className="prun-step">{s.who}</span>
                  <span>signing key <Tx h={s.mldsa} /></span>
                  <span>sealing key <Tx h={s.kem} /></span>
                </li>
              ))}
            </ol>
          </details>
        </Reveal>

        <Reveal as="section" className="psect">
          <h2 className="psect-t"><span className="shead-n">03</span>Sizes and costs</h2>
          <p className="badge">Measured in the spike, 17 November 2026</p>
          <dl className="facts facts-big">
            <div><dt>Setup per reader, once</dt><dd className="mono">0.054 QOR</dd></div>
            <div><dt>Each share or revoke record</dt><dd className="mono">about 0.017 QOR</dd></div>
            <div><dt>Key envelope, per reader</dt><dd className="mono">about 1.6 KB</dd></div>
            <div><dt>Overhead on the data</dt><dd className="mono">about 100 bytes</dd></div>
          </dl>
          <p className="muted">Setup is 278,305 gas for the ML-DSA-87 key and 247,481 gas for the ML-KEM-1024 key, at 0.1 uqor per gas. A 94 byte .env sealed to 194 bytes; the key envelope for three readers was 4,997 bytes. Sealing took 79 ms locally.</p>
        </Reveal>

        <Reveal as="section" className="psect">
          <h2 className="psect-t"><span className="shead-n">04</span>The Coffer server, right now</h2>
          <Live />
          <p className="muted">The server pays setup fees for new addresses and runs the demo teammate. It never receives your values: sealing and opening happen in your browser or terminal. Files shared with the demo teammate are opened by that teammate on the server, which reports names only.</p>
        </Reveal>
        </div>
      </div>
    </Page>
  );
}
