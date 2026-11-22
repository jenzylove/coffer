// /proof: what is real and how to inspect it. Live numbers are read now; recorded
// ones come from the repo's build log and spike, with their dates.
import { useEffect, useState, type ReactNode } from "react";
import { CopyButton, Page, Reveal } from "../components/Chrome.tsx";
import { Stamp } from "../components/Doc.tsx";
import { api, qor, short, txUrl } from "../lib/net.ts";
import { work } from "../lib/crypto.ts";

interface Stats { relayer: { address: string; uqor: number | string }; drips24h: number; teammate: string | { address: string } }

const RUN: { step: string; result: string; tx?: string }[] = [
  { step: "Ada, the demo teammate, publishes her card", result: "The contract checked her ML-DSA-87 signature and kept it", tx: "0x206b033d100c156f0ce60d5c4de3ae425c832d9da1b235cd04db35945043cbcb" },
  { step: "The owner seals a .env to a teammate (epoch 1)", result: "The sealed file goes on chain with the change", tx: "0xe79f5978f3dd39c85ada09ecd5a61b2ac5ddde18b463cede6e0875f3a67fca7b" },
  { step: "The teammate looks under their own address", result: "The file is listed; their app opens it. Nothing was sent to them" },
  { step: "The owner removes the teammate (epoch 2)", result: "Their list says \"you were removed\"", tx: "0xecce0e1de5e982a1a44bc6a2720ef9eff9d244e04a91b6f38b35cc713307e9c4" },
  { step: "The epoch 1 copy is sent back to Ada", result: "Refused: QoreChain has a newer one" },
  { step: "A card from a wallet whose key has no proof of possession", result: "Refused by the contract" },
  { step: "A card with someone else's key swapped in", result: "Refused by the contract: the signature does not match" },
];

const SETUP: { who: string; tx: string }[] = [
  { who: "Coffer contract deployed", tx: "0x57f8124d215e7b15659e917eae82192209982e1a8ce430d8197e64b97a890a68" },
]

// EVM transactions (0x…) open on the dashboard explorer; native ones on the public REST node.
const Tx = ({ h }: { h: string }) => <a className="mono txlink" href={h.startsWith("0x") ? `https://dashboard.qorechain.io/explorer/tx/${h}` : txUrl(h)} target="_blank" rel="noreferrer" title={h}>{short(h, 10, 8)}</a>;

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
        <Row n="03" title="A team on testnet, start to finish" tag="recorded 22 Nov 2026, real CLI">
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
            <summary>The contract</summary>
            <ol className="prun">
              {SETUP.map((s) => (
                <li key={s.who}><span>{s.who}</span><Tx h={s.tx} /></li>
              ))}
            </ol>
            <p className="muted small">EVM transactions open on the dashboard explorer: switch it to Testnet there.</p>
          </details>
        </Row>
        <Row n="04" title="Sizes and costs" tag="measured 22 Nov 2026">
          <dl className="facts facts-big">
            <div><dt>A card, once per person</dt><dd className="mono">about 0.06 QOR</dd></div>
            <div><dt>Each seal, share or remove</dt><dd className="mono">0.03 to 0.04 QOR</dd></div>
            <div><dt>Key envelope, per reader</dt><dd className="mono">about 1.6 KB</dd></div>
            <div><dt>Overhead on the data</dt><dd className="mono">about 100 bytes</dd></div>
          </dl>
          <p className="muted">A card is about 589,500 gas and a file record 290,000 to 361,000 gas, at 101 gwei on the testnet EVM; the Coffer server pays both, so a QoreX user pays nothing. Most of a card's cost is the 4,627 byte ML-DSA-87 signature and the 1,568 byte ML-KEM-1024 key the contract checks and keeps in its event.</p>
        </Row>
        <Row n="05" title="The Coffer server, right now" tag="live">
          <Live />
          <p className="muted">The server pays the gas for cards and file records, pays setup for keys made in a browser, and runs Ada, the demo teammate. It can't forge a card or a change: the contract checks the signatures. It never receives your values: sealing and opening happen in your browser or terminal. Files shared with Ada are opened by Ada on the server, which reports names only.</p>
        </Row>
      </div>
    </Page>
  );
}
