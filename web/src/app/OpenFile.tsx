// "Open a file": check any .env.coffer against QoreChain (the owner's signature
// against their key on chain, then the file's head in the Coffer contract), show
// who can open it, and open it if this account is on the list. Values stay in
// this component's memory and appear one at a time, only on click.
import { useState } from "react";
import { useIdentity } from "../lib/identity.tsx";
import { errCode, errText, explorerTx, short } from "../lib/net.ts";
import { approveThisBrowser, openAsReader } from "../lib/opener.ts";
import { explain } from "../lib/ops.ts";
import { work } from "../lib/crypto.ts";
import { parseCoffer, type ChainHead, type CofferFile } from "../../../src/core/vault.ts";
import type { DotenvEntry } from "../../../src/core/dotenv.ts";
import { Stamp } from "../components/Doc.tsx";
import { Addr, CopyAction, DropText, Problem, Result } from "./bits.tsx";

/** Each refusal in one plain sentence. */
const VERDICT: Record<string, string> = {
  STALE: "This is an old copy. QoreChain has a newer one, so someone removed since then might still be in it.",
  UNRECORDED: "QoreChain has no record of this version, so Coffer can't tell if it's the latest copy.",
  OWNER_MISMATCH: "QoreChain says this file belongs to someone else, so it won't be opened.",
  FORKED: "QoreChain has a different reader list for this version, so it won't be opened.",
  BAD_SIGNATURE: "Someone changed this file by hand, so it won't be opened.",
  UNKNOWN_KEY: "Whoever signed this file has no signing key on QoreChain, so it can't be checked.",
  WRITER_NOT_READER: "The last person to change it isn't on its list, so it won't be opened.",
  WRONG_CHAIN: "This file is for another QoreChain network.",
};

export function OpenFile() {
  const { address, keys, kind, owner } = useIdentity();
  const [needsDevice, setNeedsDevice] = useState(false);
  const [openTx, setOpenTx] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<CofferFile | null>(null);
  const [check, setCheck] = useState<{ ok: true; head: ChainHead | null } | { ok: false; code?: string; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [entries, setEntries] = useState<DotenvEntry[] | null>(null);

  async function load(t: string) {
    setText(t); setErr(null); setCheck(null); setFile(null); setEntries(null);
    if (!t.trim()) return;
    let f: CofferFile;
    try { f = parseCoffer(t); } catch (e) { setErr(e); return; }
    setFile(f);
    setBusy(true);
    try {
      const r = await work<{ head: ChainHead | null }>("check", { text: t });
      setCheck({ ok: true, head: r.head });
    } catch (e) {
      setCheck({ ok: false, code: errCode(e), msg: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  /** The owner opens with its own copy; anyone else asks QoreChain, which records the open. */
  async function open() {
    if (!file || !keys || !address) return;
    setErr(null); setOpening(true); setNeedsDevice(false);
    try {
      if (file.owner === address) { setEntries(await work<DotenvEntry[]>("ownerOpen", { text, keys })); setOpenTx(null); }
      else { const o = await openAsReader({ address, keys, kind, owner }, text, false); setEntries(o.entries); setOpenTx(o.hash); }
    } catch (e) {
      if (errCode(e) === "NEEDS_DEVICE") setNeedsDevice(true);
      else setErr(e);
    } finally {
      setOpening(false);
    }
  }

  async function approve() {
    if (!address || !owner) return;
    setErr(null); setOpening(true);
    try { await approveThisBrowser({ address, owner }); setOpening(false); await open(); }
    catch (e) { setErr(e); setOpening(false); }
  }

  const isReader = !!file && !!address && file.readers.includes(address);
  const code = err ? errCode(err) : undefined;

  return (
    <section className="panel" aria-labelledby="h-open">
      <h2 id="h-open" className="h-section">Open a file.</h2>
      <div className={file ? "drop-loaded" : ""}>
        <DropText id="cofferfile" label={file ? `Loaded ${file.name}.coffer. Paste or drop another to check it.` : "Your .env.coffer"} value={text} onChange={(t) => void load(t)} rows={file ? 2 : 6} placeholder="Paste a sealed file, or drop it here" />
      </div>
      {err !== null && <Problem error={err} text={code === "BAD_FORMAT" ? "This isn't a Coffer file." : code === "OLD_FORMAT" ? explain(code, "") : undefined} />}

      {file && (
        <>
          <div className="verdict" aria-live="polite">
            {busy || !check ? <p className="prog-line">Checking it against QoreChain…</p> : check.ok ? (
              <>
                <Stamp className="beat-word">Checks out</Stamp>
                <p>Signed by its owner, and the newest version QoreChain has.</p>
                <p className="muted small">Owner {short(file.owner, 8, 4)}. A valid signature proves who made it, not that you know them: check this is your teammate.</p>
              </>
            ) : (
              <>
                <Stamp tone="red" className="beat-word">Refused</Stamp>
                <p>{VERDICT[check.code ?? ""] ?? explain(check.code, check.msg)}</p>
                <details className="steps"><summary>Details</summary><p className="mono">{check.code ? `${check.code}: ` : ""}{check.msg}</p></details>
              </>
            )}
          </div>

          <FileView file={file} me={address ?? undefined} head={check?.ok ? check.head : undefined} />

          {check?.ok && (
            <div className="opened">
              {!isReader ? (
                <div className="calm">
                  <p>You're not on the list for this file. Send its owner your address and ask them to add you.</p>
                  {address && <div className="acts"><CopyAction className="link" text={address} label="Copy my address" done="Address copied" /></div>}
                </div>
              ) : !keys ? <Result>This browser doesn't have your key. Load your key file first.</Result>
                : needsDevice ? (
                  <div className="ready-line" role="status">
                    <p>Approve this browser for a day (one signature in QoreX). Then files open here without asking.</p>
                    <button className="btn" disabled={opening} onClick={() => void approve()}>{opening ? "Waiting for QoreX" : "Approve this browser"}</button>
                  </div>
                ) : !entries ? <button className="btn" disabled={opening} onClick={open}>{opening ? "Asking QoreChain" : "Open with my key"}</button>
                  : <>
                    <Values entries={entries} onClose={() => setEntries(null)} />
                    {openTx && <p className="file-line"><span>Opened</span><span className="dot" aria-hidden>·</span><a className="link-sm" href={explorerTx(openTx)} target="_blank" rel="noreferrer">recorded on QoreChain</a></p>}
                  </>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Values({ entries, onClose }: { entries: DotenvEntry[]; onClose: () => void }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="values">
      <Result>Opened. {entries.length} {entries.length === 1 ? "value" : "values"}; tap one to show it.</Result>
      <ul>
        {entries.map((e) => (
          <li key={e.key}>
            <span className="mono vkey">{e.key}</span>
            <button className={`mono vval ${shown[e.key] ? "on" : ""}`} onClick={() => setShown((s) => ({ ...s, [e.key]: !s[e.key] }))} aria-label={shown[e.key] ? `Hide ${e.key}` : `Show ${e.key}`}>
              {shown[e.key] ? (e.value || "(empty)") : <span className="bar" style={{ width: "12ch" }} aria-hidden />}
            </button>
            <button className="copy" onClick={async () => { try { await navigator.clipboard.writeText(e.value); setCopied(e.key); setTimeout(() => setCopied(null), 1400); } catch { /* blocked */ } }}>
              {copied === e.key ? "Copied" : "Copy"}
            </button>
          </li>
        ))}
      </ul>
      <div className="acts">
        <span className="muted small">Values live in this page's memory only. Close the page and they're gone.</span>
        <button className="link" onClick={onClose}>Hide all</button>
      </div>
    </div>
  );
}

/** Who can open the file, as people; the raw numbers and QoreChain's record sit behind Details. */
export function FileView({ file, me, head }: { file: CofferFile; me?: string; head?: ChainHead | null }) {
  const who = (a: string) => (a === me ? (a === file.owner ? "You (owner)" : "You") : a === file.owner ? "Owner" : "Reader");
  const sorted = [...file.readers].sort((a, b) => (a === file.owner ? -1 : b === file.owner ? 1 : 0));
  return (
    <div className="team" aria-label="Who can open this file">
      <p className="label">Who can open it ({file.readers.length})</p>
      <ul className="people">
        {sorted.map((a) => (
          <li key={a}><span className="person">{who(a)}</span><Addr a={a} /><span /></li>
        ))}
      </ul>
      <details className="raw">
        <summary>Details</summary>
        <dl className="facts">
          <div><dt>File</dt><dd className="mono">{file.name}.coffer</dd></div>
          <div><dt>File id</dt><dd className="mono">{file.id}</dd></div>
          <div><dt>This copy</dt><dd className="mono">epoch {String(file.epoch)} · version {String(file.version)}</dd></div>
          {head && <div><dt>On QoreChain</dt><dd className="mono">epoch {String(head.epoch)} · version {String(head.version)} · block {head.height}</dd></div>}
          {head === null && <div><dt>On QoreChain</dt><dd>No record</dd></div>}
        </dl>
      </details>
    </div>
  );
}
