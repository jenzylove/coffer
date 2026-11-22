// /proof: what is real and how to inspect it. Live numbers are read now; recorded
// ones come from the repo's build log and spike, with their dates.
import { useEffect, useState, type ReactNode } from "react";
import { CopyButton, Page, Reveal } from "../components/Chrome.tsx";
import { Stamp } from "../components/Doc.tsx";
import { api, qor, short, txUrl } from "../lib/net.ts";
import { work } from "../lib/crypto.ts";

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

interface Config { chainId: string; contract: string | null; poster: string | null; teammate: string }
interface Facts {
  contract: string;
  card: { block: number; hash: string | null; issuedAt: string } | null;
  head: { file: string; owner: string; epoch: bigint; version: bigint; block: number; hash: string; current: { epoch: bigint; version: bigint; height: number } | null } | null;
}

/** The Coffer contract, read now: its address, Ada's card, and the newest file record. */
function Contract() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [f, setF] = useState<Facts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  useEffect(() => {
    let live = true;
    api<Config>("/api/config")
      .then((c) => {
        if (live) setCfg(c);
        if (!c.contract) throw new Error("the contract isn't set up on this server yet");
        return work<Facts>("proofFacts", { teammate: c.teammate });
      })
      .then((x) => { if (live) { setF(x); setAt(new Date()); } })
      .catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, []);
  return (
    <>
      <p className="live-line"><Stamp className="stamp-sm">Live</Stamp><span className="muted small">{at ? `read from QoreChain at ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "reading"}</span></p>
      {err ? <p className="problem-line">The contract can't be read right now: {err}</p> : !f ? <p className="muted">Reading QoreChain…</p> : (
        <dl className="facts facts-big">
          <div><dt>Coffer contract</dt><dd><span className="mono" title={f.contract}>{short(f.contract, 10, 8)}</span> <CopyButton text={f.contract} /></dd></div>
          <div><dt>Ada's card</dt><dd>{f.card ? (f.card.hash ? <Tx h={f.card.hash} /> : <span className="mono">block {f.card.block}</span>) : <span className="muted">not on chain yet</span>}</dd></div>
          <div><dt>Newest file record</dt><dd className="mono">{f.head ? `epoch ${String(f.head.epoch)} · version ${String(f.head.version)}` : "none yet"}</dd></div>
          {f.head && <div><dt>Recorded in</dt><dd><Tx h={f.head.hash} /></dd></div>}
        </dl>
      )}
      {f?.head && (
        <details className="mini">
          <summary>That file's record, live</summary>
          <p>File <span className="mono">{f.head.file}</span>, owner <span className="mono">{short(f.head.owner, 8, 4)}</span>. Right now QoreChain holds {f.head.current ? <span className="mono">epoch {String(f.head.current.epoch)}, version {String(f.head.current.version)}, block {f.head.current.height}</span> : "no record"}. A copy older than that is refused.</p>
        </details>
      )}
      {cfg?.teammate && <p className="muted small">Ada, the demo teammate: <span className="mono">{short(cfg.teammate, 8, 4)}</span></p>}
    </>
  );
}

function Live() {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  useEffect(() => {
    api<Stats>("/api/stats").then((x) => { setS(x); setAt(new Date()); }).catch((e) => setErr((e as Error).message));
  }, []);
  const mate = s ? (typeof s.teammate === "string" ? s.teammate : s.teammate?.address) : null;
  return (
    <>
      <p className="live-line"><Stamp className="stamp-sm">Live</Stamp><span className="muted small">{at ? `read at ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "reading"}</span></p>
      {err ? <p className="problem-line">Live stats aren't available right now: {err}</p> : !s ? <p className="muted">Reading the Coffer server…</p> : (
        <dl className="facts facts-big">
          <div><dt>Relayer balance</dt><dd className="mono">{qor(BigInt(s.relayer.uqor))} test QOR</dd></div>
          <div><dt>Addresses funded, last 24 hours</dt><dd className="mono">{s.drips24h}</dd></div>
          <div><dt>Relayer</dt><dd className="mono">{short(s.relayer.address, 8, 4)}</dd></div>
          {mate && <div><dt>Ada, demo teammate</dt><dd className="mono">{short(mate, 8, 4)}</dd></div>}
        </dl>
      )}
    </>
  );
}

function Row({ n, title, tag, children }: { n: string; title: string; tag: string; children: ReactNode }) {
  return (
    <Reveal as="section" className="proof-row">
      <div className="proof-row-head">
        <span className="mono why-n">{n}</span>
        <div><h2 className="proof-row-title">{title}</h2><p className="mono small muted">{tag}</p></div>
      </div>
      <div className="proof-row-body">{children}</div>
    </Reveal>
  );
}

export default function Proof() {
  return (
    <Page>
      <section className="page-head">
        <div className="wrap">
          <h1 className="h-display h1">What's real.</h1>
          <p className="lead">Each number is either read live from the Coffer server and QoreChain, or recorded from a testnet run with a transaction you can open. Each one says which.</p>
        </div>
      </section>
      <div className="wrap proof">
        <Row n="01" title="The exposure" tag="recorded 17 Nov 2026">
          <div className="pnums">
            <div><p className="count-n count-sm">2,284</p><p>public GitHub files contain <span className="mono">DOTENV_PUBLIC_KEY</span>, the mark of a dotenvx encrypted file.</p></div>
            <div><p className="count-n count-sm">1,716</p><p>of those also hold <span className="mono">encrypted:</span> values, locked with secp256k1.</p></div>
          </div>
          <details className="mini" open>
            <summary>Method</summary>
            <p>GitHub code search on 17 November 2026. Query one: <span className="mono">DOTENV_PUBLIC_KEY</span>. Query two: <span className="mono">DOTENV_PUBLIC_KEY encrypted:</span>. Counts are approximate and cover indexed default branches only.</p>
          </details>
        </Row>
        <Row n="02" title="The Coffer contract on QoreChain" tag="live">
          <Contract />
          <p className="muted">Each teammate's card and each file's latest change live here. The contract checks every signature with QoreChain's own ML-DSA-87 check, keeps the newest card per account, and only lets a file's record move forward.</p>
        </Row>
        <Row n="03" title="A three person team on testnet" tag="recorded 17 Nov 2026, real CLI">
          <ol className="prun">
            {RUN.map((r) => (
              <li key={r.step}>
                <span>{r.step}</span>
                <span className="muted">{r.result.startsWith("Refused") ? <><span className="no">Refused</span>{r.result.slice(7)}</> : r.result}</span>
                {r.tx ? <Tx h={r.tx} /> : <span className="muted small">no transaction</span>}
              </li>
            ))}
          </ol>
          <details className="mini">
            <summary>The six setup transactions</summary>
            <ol className="prun">
              {SETUP.map((s) => (
                <li key={s.who}><span>{s.who}</span><span>signing key <Tx h={s.mldsa} /></span><span>sealing key <Tx h={s.kem} /></span></li>
              ))}
            </ol>
          </details>
        </Row>
        <Row n="04" title="Sizes and costs" tag="measured 17 Nov 2026">
          <dl className="facts facts-big">
            <div><dt>Setup per reader, once</dt><dd className="mono">0.054 QOR</dd></div>
            <div><dt>Each share or revoke record</dt><dd className="mono">about 0.017 QOR</dd></div>
            <div><dt>Key envelope, per reader</dt><dd className="mono">about 1.6 KB</dd></div>
            <div><dt>Overhead on the data</dt><dd className="mono">about 100 bytes</dd></div>
          </dl>
          <p className="muted">Setup is 278,305 gas for the ML-DSA-87 key and 247,481 gas for the ML-KEM-1024 key, at 0.1 uqor per gas. A 94 byte .env sealed to 194 bytes; the key envelope for three readers was 4,997 bytes. Sealing took 79 ms locally.</p>
        </Row>
        <Row n="05" title="The Coffer server, right now" tag="live">
          <Live />
          <p className="muted">The server pays the gas for cards and file records, pays setup for keys made in a browser, and runs Ada, the demo teammate. It can't forge a card or a change: the contract checks the signatures. It never receives your values: sealing and opening happen in your browser or terminal. Files shared with Ada are opened by Ada on the server, which reports names only.</p>
        </Row>
      </div>
    </Page>
  );
}
