// /app: one identity (QoreX first), the files you own, the files shared with
// you (found on QoreChain, no paste), and one file at a time as the document.
// Every change is one QoreX approval, recorded on QoreChain before the new
// version is kept. Raw data stays behind "Details".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Page } from "../components/Chrome.tsx";
import { Bar, Sheet, Stamp } from "../components/Doc.tsx";
import { IdentityProvider, useIdentity, isReady } from "../lib/identity.tsx";
import { api, coded, copyText, download, errCode, errText, explorerTx, isQorAddress, qor, short, sleep } from "../lib/net.ts";
import { SETUP_UQOR, dripAndWait, explain, loadFiles, publishCard, recordHead, saveFiles, type Recorded, type Stored } from "../lib/ops.ts";
import { onWalletAsk, work } from "../lib/crypto.ts";
import { changedReaders, hasCard, inbox as readInbox, readHead, registerIdentity, type Delivered } from "../lib/chain.ts";
import { parseCoffer, type ChainHead } from "../../../src/core/vault.ts";
import { parseDotenv, serializeDotenv, type DotenvEntry } from "../../../src/core/dotenv.ts";
import { IMPORT_KEY, type ImportHint } from "../landing/ScanDoor.tsx";
import { Addr, Chips, CopyAction, DropText, KeyFilePicker, Log, Problem, Progress, RecordFacts, Result, TxLink, type LogLine } from "./bits.tsx";
import { OpenFile } from "./OpenFile.tsx";
import { Toaster, toast } from "../components/Toast.tsx";

// Files shared with an address that it has already looked at, so new arrivals can say "New".
const seenKey = (a: string) => `coffer.seen.${a}`;
function seenIds(a: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(seenKey(a)) ?? "[]")); } catch { return new Set(); }
}
function markSeen(a: string, id: string) {
  try { const s = seenIds(a); if (!s.has(id)) { s.add(id); localStorage.setItem(seenKey(a), JSON.stringify([...s])); } } catch { /* storage blocked */ }
}

const idOf = (s: Stored) => { try { return parseCoffer(s.text).id; } catch { return ""; } };
const ownerOf = (s: Stored) => { try { return parseCoffer(s.text).owner; } catch { return ""; } };
const epochOf = (s: Stored) => { try { return parseCoffer(s.text).epoch; } catch { return 0n; } };

function ago(iso: string): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

function useLog() {
  const [lines, setLines] = useState<LogLine[]>([]);
  return useMemo(() => ({
    lines,
    reset: () => setLines([]),
    step: (text: string, hash?: string) => setLines((x) => [...x.map((y) => (y.state === "doing" ? { ...y, state: "done" as const } : y)), { text, hash, state: hash ? "done" : "doing" }]),
    done: (text?: string, hash?: string) => setLines((x) => [...x.map((y) => (y.state === "doing" ? { ...y, state: "done" as const } : y)), ...(text ? [{ text, hash, state: "done" as const }] : [])]),
    fail: () => setLines((x) => x.map((y) => (y.state === "doing" ? { ...y, state: "err" as const } : y))),
  }), [lines]);
}

/** On a phone the list sits under the document: bring the document into view after a pick. */
function showMain() {
  if (matchMedia("(max-width: 899px)").matches) document.querySelector(".dash-main")?.scrollIntoView({ block: "start" });
}

// ---- invites: /app?invite=<owner>&for=<invited address>&file=<id> ---------------------
// An invite with `for` is for one wallet only. Without it (an older link), anyone may take it.

interface Invite { owner: string; for: string | null; file: string | null }
const INVITE_KEY = "coffer.invite";
function readInvite(): Invite | null {
  const q = new URLSearchParams(location.search);
  const owner = q.get("invite") ?? q.get("from");
  if (owner && isQorAddress(owner)) {
    const to = q.get("for"), file = q.get("file");
    const inv: Invite = { owner, for: to && isQorAddress(to) ? to : null, file: file && /^[0-9a-f]{32}$/.test(file) ? file : null };
    try { sessionStorage.setItem(INVITE_KEY, JSON.stringify(inv)); } catch { /* storage blocked */ }
    return inv;
  }
  try { const t = sessionStorage.getItem(INVITE_KEY); return t ? (JSON.parse(t) as Invite) : null; } catch { return null; }
}
const inviteLink = (owner: string, to: string, file: string) => `${location.origin}/app?invite=${owner}&for=${to}&file=${file}`;

export default function AppRoute() {
  return (
    <IdentityProvider>
      <Page>
        <App />
        <Toaster />
      </Page>
    </IdentityProvider>
  );
}

function App() {
  const ident = useIdentity();
  const [invite, setInvite] = useState(readInvite);
  const ready = isReady(ident.status);
  // "Ready." stays on screen for a moment, but only after a setup this visit
  const sawSetup = useRef(false);
  if (ident.status && !ready) sawSetup.current = true;
  const [celebrated, setCelebrated] = useState(false);
  const celebrating = ready && sawSetup.current && !celebrated;
  useEffect(() => {
    if (!celebrating) return;
    const t = setTimeout(() => setCelebrated(true), 1600);
    return () => clearTimeout(t);
  }, [celebrating]);
  const inviteDone = useCallback(() => {
    try { sessionStorage.removeItem(INVITE_KEY); } catch { /* storage blocked */ }
    if (location.search) history.replaceState(null, "", "/app" + location.hash);
    setInvite(null);
  }, []);

  const booting = !!ident.busy && !!ident.kind && ident.busy !== "Waiting for QoreX.";
  // an invite for one wallet: only that wallet can take it, so no "use this browser" here
  if (invite?.for && ident.address !== invite.for) {
    if (booting || ident.qorexAvailable === null) return <Hold title={ident.busy ?? "Looking for QoreX."} line="This takes a moment." />;
    if (!ident.qorexAvailable) return <InviteNoWallet invite={invite} />;
    if (ident.kind === "qorex" && ident.address) return <InviteWrongAccount invite={invite} />;
    return <Connect invite={invite} />;
  }
  if (!ident.address) return booting ? <Hold title={ident.busy!} line="This takes a moment." /> : <Connect invite={invite} />;
  if (!ident.status && !ident.statusError) return <Hold title="Checking QoreChain." line="Reading your keys and your card." />;
  if (!ready || celebrating) return <Setup invite={invite} />;
  return <Dashboard invite={invite} onInviteDone={inviteDone} />;
}

function Hold({ title, line }: { title: string; line: string }) {
  return (
    <section className="onboard" id="address">
      <div className="wrap onboard-in">
        <h1 className="h-display h1">{title}</h1>
        <p className="lead">{line}</p>
        <span className="prog-bar" aria-hidden><span className="indeterminate" /></span>
      </div>
    </section>
  );
}

// ---- connect ---------------------------------------------------------------------

function Connect({ invite }: { invite: Invite | null }) {
  const ident = useIdentity();
  const [err, setErr] = useState<unknown>(null);
  const waiting = ident.busy !== null;
  const error = err ?? ident.error;
  const only = !!invite?.for; // an invite for one QoreX wallet
  return (
    <section className="onboard" id="address">
      <div className="wrap onboard-in">
        {invite ? (
          <>
            <h1 className="h-display h1">You're invited.</h1>
            <p className="lead"><span className="mono">{short(invite.owner, 8, 4)}</span> invited you to open a sealed .env. Connect QoreX and sign once (no fee).{only ? "" : " Then send them your address."}</p>
          </>
        ) : (
          <>
            <h1 className="h-display h1">Connect QoreX.</h1>
            <p className="lead">Coffer seals your .env to your team's QoreChain wallets. Connect QoreX and sign once. It's free and sends nothing.</p>
          </>
        )}
        <div className="actions">
          <button className="btn" disabled={waiting} onClick={() => void ident.connectQorex()}>
            {ident.busy === "Waiting for QoreX." ? "Waiting for QoreX" : "Connect QoreX"}
          </button>
          {!only && <button className="link" disabled={waiting} onClick={() => void ident.chooseBrowser()}>No QoreX? Use this browser</button>}
          {!only && <KeyFilePicker onText={async (t) => { setErr(null); try { await ident.loadKeyFile(t); } catch (e) { setErr(e); } }} />}
        </div>
        {ident.busy === "Making a key in this browser." && <Progress lines={[{ text: "Making a key in this browser", state: "doing" }]} />}
        {ident.walletMissing && !only && (
          <div className="calm">
            <p>QoreX isn't in this browser. Install the QoreX extension and reload this page, or use this browser instead: Coffer keeps a key here and pays its setup.</p>
          </div>
        )}
        {error !== null && error !== undefined && <Problem error={error} />}
      </div>
    </section>
  );
}

function InviteNoWallet({ invite }: { invite: Invite }) {
  const link = invite.for && invite.file ? inviteLink(invite.owner, invite.for, invite.file) : location.href;
  return (
    <section className="onboard" id="address">
      <div className="wrap onboard-in">
        <h1 className="h-display h1">Open this in your wallet's browser.</h1>
        <p className="lead">This invite is for a QoreX wallet (<span className="mono">{short(invite.for ?? "", 8, 4)}</span>). Open this link in the browser where that wallet is installed.</p>
        <div className="actions"><CopyAction className="btn-outline" text={link} label="Copy this link" done="Link copied" /></div>
      </div>
    </section>
  );
}

function InviteWrongAccount({ invite }: { invite: Invite }) {
  const ident = useIdentity();
  const waiting = ident.busy !== null;
  return (
    <section className="onboard" id="address">
      <div className="wrap onboard-in">
        <h1 className="h-display h1">Switch account in QoreX.</h1>
        <p className="lead">This invite is for <span className="mono">{short(invite.for ?? "", 8, 4)}</span>. QoreX is on <span className="mono">{short(ident.address ?? "", 8, 4)}</span>. Switch account in QoreX, then press Try again.</p>
        <div className="actions"><button className="btn" disabled={waiting} onClick={() => void ident.connectQorex()}>{waiting ? "Checking" : "Try again"}</button></div>
        {ident.error !== null && ident.error !== undefined && <Problem error={ident.error} />}
      </div>
    </section>
  );
}

// ---- setup: one card on QoreChain --------------------------------------------------

function Setup({ invite }: { invite: Invite | null }) {
  // the App keeps this screen up with "Ready." for a moment once the status says so
  const ident = useIdentity();
  const { kind, status, statusError } = ident;
  const ready = isReady(status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const log = useLog();
  const tried = useRef(false);
  const browserOk = !invite?.for; // an invite for one wallet never offers a browser key

  /** After the card is on chain, wait until QoreChain shows it with these keys. */
  const waitForCard = useCallback(async () => {
    log.step("Waiting for QoreChain to show it");
    for (let i = 0; i < 30; i++) {
      const st = await ident.refresh();
      if (isReady(st)) { log.done(); return; }
      await sleep(2000);
    }
    throw new Error("QoreChain has the card but isn't showing it yet. Check again in a minute.");
  }, [ident, log]);

  const signCard = useCallback(async (fresh: boolean) => {
    if (!ident.owner) return;
    setBusy(true); setErr(null); log.reset();
    try {
      const keys = fresh ? await ident.newKey() : await ident.ensureKeys();
      await publishCard(ident.owner, keys, (s, h) => log.step(s, h));
      await waitForCard();
    } catch (e) {
      log.fail();
      setErr(e);
    } finally {
      setBusy(false);
    }
  }, [ident, log, waitForCard]);

  const setupBrowser = useCallback(async () => {
    const id = ident.id;
    if (!id || !ident.owner) return;
    setBusy(true); setErr(null); log.reset();
    try {
      log.step("Checking this key on QoreChain");
      let st = await ident.refresh();
      if (!st) throw coded("REST_ERROR", "QoreChain can't be reached right now.");
      if (!st.pq || !st.kemIsOurs) {
        if (st.uqor < SETUP_UQOR) {
          log.step("Paying setup");
          await dripAndWait(id.address, SETUP_UQOR, (_t, h) => log.step("Setup paid by the Coffer relayer", h));
        }
        await registerIdentity(id, (s, h) => {
          if (h) log.step(s.startsWith("ML-DSA") ? "Signing key registered" : "Sealing key published", h);
          else log.step(s.startsWith("registering") ? "Registering your signing key" : "Publishing your sealing key");
        });
        st = await ident.refresh();
      }
      if (st?.card.state === "error") throw coded(st.card.code ?? "NO_CONTRACT", st.card.message);
      if (st?.card.state !== "ours") {
        await publishCard(ident.owner, id.sealKeys, (s, h) => log.step(s, h));
        await waitForCard();
      } else {
        log.done();
      }
    } catch (e) {
      log.fail();
      setErr(e);
    } finally {
      setBusy(false);
    }
  }, [ident, log, waitForCard]);

  // a key in this browser sets itself up; QoreX asks for the card at once only right after Connect
  useEffect(() => {
    if (tried.current || ready || !status || busy) return;
    if (kind === "local") { tried.current = true; void setupBrowser(); }
    else if (kind === "qorex" && ident.justConnected && status.pq && status.card.state === "none") { tried.current = true; void signCard(false); }
  }, [kind, ready, status, busy, ident.justConnected, setupBrowser, signCard]);

  // no signing key on chain yet: look again every 10 seconds
  const needsSend = kind === "qorex" && !!status && !status.pq;
  useEffect(() => {
    if (!needsSend) return;
    const t = setInterval(() => void ident.refresh(), 10_000);
    return () => clearInterval(t);
  }, [needsSend, ident]);

  const card = status?.card;
  const by = invite ? <p className="muted small">Invited by <span className="mono">{short(invite.owner, 8, 4)}</span></p> : null;
  const details = log.lines.length > 0 && <details className="raw"><summary>Steps</summary><Log lines={log.lines} /></details>;
  let body;
  if (ready) {
    body = <><h1 className="h-display h1">Ready.</h1><Result>Anyone can seal files to you now.</Result></>;
  } else if (!status) {
    body = (
      <>
        <h1 className="h-display h1">Can't reach QoreChain.</h1>
        <Problem error={statusError} />
        <div className="actions"><button className="btn" onClick={() => void ident.refresh()}>Try again</button></div>
      </>
    );
  } else if (kind === "local") {
    body = (
      <>
        <h1 className="h-display h1">{err ? "Setup stopped." : "Setting up this browser."}</h1>
        <p className="lead">Coffer puts your public keys on QoreChain so teammates can seal files to you. The Coffer relayer pays.</p>
        {busy && <Progress lines={log.lines} />}
        {err !== null && <Problem error={err} />}
        {!busy && err !== null && (
          <div className="actions">
            <button className="btn" onClick={() => void setupBrowser()}>Try again</button>
            <button className="link" onClick={() => ident.disconnect()}>Use QoreX instead</button>
          </div>
        )}
        {details}
      </>
    );
  } else if (!status.pq) {
    body = (
      <>
        <h1 className="h-display h1">One step in QoreX first.</h1>
        <p className="lead">Send any amount once from QoreX. To yourself is fine. QoreX registers its quantum safe key with the first transfer, and this page checks again every few seconds.</p>
        <div className="actions">
          <button className="btn-outline" onClick={() => void ident.refresh()}>Check again</button>
          {browserOk && <button className="link" onClick={() => void ident.chooseBrowser()}>Use this browser instead</button>}
        </div>
      </>
    );
  } else if (card?.state === "error") {
    body = (
      <>
        <h1 className="h-display h1">Not open yet.</h1>
        <Problem error={coded(card.code ?? "NO_CONTRACT", card.message)} />
        <div className="actions"><button className="btn" onClick={() => void ident.refresh()}>Try again</button></div>
      </>
    );
  } else if (card?.state === "other") {
    body = (
      <>
        <h1 className="h-display h1">Your key is in another browser.</h1>
        <p className="lead">This wallet signed its card somewhere else, so the key that opens your files is there. Load your key file, or make a new key here.</p>
        <div className="actions">
          <KeyFilePicker className="btn" onText={async (t) => { setErr(null); try { await ident.loadKeyFile(t); } catch (e) { setErr(e); } }} />
          <button className="btn-outline" disabled={busy} onClick={() => void signCard(true)}>{busy ? "Making a new key" : "Make a new key here"}</button>
        </div>
        <p className="muted small">A new key works at once for new files. Files already shared with you need sharing again; the owner's app does that with one click.</p>
        {busy && <Progress lines={log.lines} />}
        {err !== null && <Problem error={err} />}
        {details}
      </>
    );
  } else {
    body = (
      <>
        <h1 className="h-display h1">{busy ? "Sign once in QoreX." : "One signature to finish."}</h1>
        <p className="lead">QoreX shows a short card with your public keys. Signing is free and sends nothing. Then anyone can seal files to your address.</p>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => void signCard(false)}>{busy ? "Signing" : "Sign in QoreX"}</button>
          {!busy && browserOk && errCode(err) === "CARD_REFUSED" && <button className="link" onClick={() => void ident.chooseBrowser()}>Use this browser instead</button>}
        </div>
        {busy && <Progress lines={log.lines} />}
        {err !== null && <Problem error={err} />}
        {details}
      </>
    );
  }
  return (
    <section className="onboard" id="address">
      <div className="wrap onboard-in">{by}{body}</div>
    </section>
  );
}

// ---- the dashboard ---------------------------------------------------------------

type View = { kind: "file"; id: string } | { kind: "shared"; id: string } | { kind: "seal" } | { kind: "open" };

function Dashboard({ invite, onInviteDone }: { invite: Invite | null; onInviteDone: () => void }) {
  const { address } = useIdentity();
  const [files, setFilesRaw] = useState<Stored[]>(loadFiles);
  const setFiles = useCallback((f: (x: Stored[]) => Stored[]) => setFilesRaw((x) => { const n = f(x); if (n !== x) saveFiles(n); return n; }), []);
  const mine = useMemo(() => files.filter((s) => ownerOf(s) === address), [files, address]);
  // what QoreChain says: every file this address is or was a reader of
  const [chain, setChain] = useState<Delivered[] | null>(null);
  const shared = useMemo(() => (chain ?? []).filter((d) => d.owner !== address), [chain, address]);
  const announced = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!address || chain === null) return;
    const can = shared.filter((d) => d.readers.includes(address));
    if (announced.current === null) { announced.current = new Set(can.map((d) => d.id)); return; } // first read: the list shows them
    for (const d of can) {
      if (announced.current.has(d.id)) continue;
      announced.current.add(d.id);
      toast(`${short(d.owner, 6, 4)} shared ${d.name} with you. It's under Shared with you.`);
    }
  }, [shared, address, chain]);
  const picked = useRef(false);
  const [view, setView] = useState<View>(() => {
    if (location.hash === "#open") return { kind: "open" };
    if (location.hash === "#seal" || !mine.length) return { kind: "seal" };
    return { kind: "file", id: idOf(mine[0]!) };
  });
  const pick = useCallback((v: View, byUser = true) => {
    if (byUser) picked.current = true;
    history.replaceState(null, "", `/app${location.search}${v.kind === "open" ? "#open" : v.kind === "seal" ? "#seal" : ""}`);
    setView(v);
    if (byUser) showMain();
  }, []);
  useEffect(() => {
    const on = () => { if (location.hash === "#open") setView({ kind: "open" }); else if (location.hash === "#seal") setView({ kind: "seal" }); };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  // an invite this account can take: wait here until the owner adds it, then open the file
  const awaiting = !!invite && (!invite.for || invite.for === address);
  const load = useCallback(async () => {
    if (!address) return;
    try { setChain(await readInbox(address)); } catch { /* keep the last list; try again on the next tick */ }
  }, [address]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), awaiting ? 8_000 : 20_000);
    return () => clearInterval(t);
  }, [load, awaiting]);

  // files this account owns on chain come into this browser too (a new browser, or changes made elsewhere)
  useEffect(() => {
    if (!chain || !address) return;
    setFiles((list) => {
      let next = list;
      for (const d of chain.filter((x) => x.owner === address)) {
        const i = next.findIndex((s) => idOf(s) === d.id);
        if (i < 0) {
          next = [...next, { text: d.text, tx: d.hash ?? undefined, block: d.height, changed: "", note: "Sealed. Safe to commit." }];
        } else if (d.epoch > epochOf(next[i]!)) {
          next = next.map((s, j) => (j === i ? { ...s, text: d.text, tx: d.hash ?? s.tx, block: d.height, changed: new Date().toISOString() } : s));
        }
      }
      return next;
    });
  }, [chain, address, setFiles]);

  // a teammate's first view is the newest file shared with them
  useEffect(() => {
    if (!chain || picked.current || awaiting) return;
    if (view.kind === "seal" && !mine.length && shared.length && location.hash !== "#seal") {
      const d = shared.find((x) => x.readers.includes(address ?? "")) ?? shared[0]!;
      pick({ kind: "shared", id: d.id }, false);
    }
  }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps

  // the invited file has arrived: open it
  useEffect(() => {
    if (!chain || !invite || !awaiting || !address) return;
    const mineToOpen = (x: Delivered) => x.owner === invite.owner && x.readers.includes(address);
    const d = invite.file ? chain.find((x) => x.id === invite.file && mineToOpen(x)) : chain.find(mineToOpen);
    if (d) { onInviteDone(); pick({ kind: "shared", id: d.id }, false); }
  }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps

  // invited teammates who have signed their card since: ready to add (any page)
  const waitingAll = useMemo(() => {
    const out: { fileId: string; a: string }[] = [];
    for (const s of mine) {
      let readers: string[];
      try { readers = parseCoffer(s.text).readers; } catch { continue; }
      for (const a of s.waiting ?? []) if (!readers.includes(a)) out.push({ fileId: idOf(s), a });
    }
    return out;
  }, [mine]);
  const waitKey = [...new Set(waitingAll.map((w) => w.a))].sort().join(",");
  const [ready, setReady] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const list = waitKey ? waitKey.split(",").filter((a) => !ready[a]) : [];
    if (!list.length) return;
    let live = true;
    const tick = async () => {
      for (const a of list) {
        const has = await hasCard(a).catch(() => false);
        if (has && live) setReady((r) => ({ ...r, [a]: true }));
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 10_000);
    return () => { live = false; clearInterval(t); };
  }, [waitKey, ready]);
  const readyAll = waitingAll.filter((w) => ready[w.a]);

  const update = (fileId: string, patch: Partial<Stored>) => setFiles((list) => list.map((s) => (idOf(s) === fileId ? { ...s, ...patch, changed: new Date().toISOString() } : s)));
  const current = view.kind === "file" ? mine.find((s) => idOf(s) === view.id) : undefined;
  const sharedNow = view.kind === "shared" ? (chain ?? []).find((d) => d.id === view.id) : undefined;

  return (
    <div className="dash wrap">
      <Sidebar mine={mine} shared={shared} chainRead={chain !== null} view={awaiting ? null : view} pick={(v) => { if (awaiting) onInviteDone(); pick(v); }} readyAll={readyAll} />
      <div className="dash-main">
        {awaiting && invite ? <InvitePanel invite={invite} onDone={onInviteDone} /> : <>
          {view.kind === "seal" && (
            <SealPanel first={!mine.length && !shared.length} onSealed={(text, rec) => {
              const f = parseCoffer(text);
              const at = new Date().toISOString();
              setFiles((list) => [{ text, tx: rec.hash, block: rec.block, changed: at, note: "Sealed. Safe to commit.", log: [{ what: "Sealed", hash: rec.hash, block: rec.block, at }] }, ...list]);
              toast(`Sealed ${f.name} and recorded it on QoreChain. Now add who can open it.`);
              pick({ kind: "file", id: f.id }, false);
            }} />
          )}
          {view.kind === "open" && <OpenFile />}
          {view.kind === "file" && current && <FileDetail stored={current} ready={ready} onChange={(patch) => { update(idOf(current), patch); void load(); }} />}
          {view.kind === "file" && !current && <p className="muted">That file isn't in this browser any more.</p>}
          {view.kind === "shared" && sharedNow && <SharedView d={sharedNow} />}
          {view.kind === "shared" && !sharedNow && <p className="muted">{chain === null ? "Looking on QoreChain…" : "That file isn't shared with you any more."}</p>}
        </>}
      </div>
    </div>
  );
}

function Sidebar({ mine, shared, chainRead, view, pick, readyAll }: {
  mine: Stored[]; shared: Delivered[]; chainRead: boolean; view: View | null;
  pick: (v: View) => void; readyAll: { fileId: string; a: string }[];
}) {
  const ident = useIdentity();
  const { address, kind, status } = ident;
  const [err, setErr] = useState<unknown>(null);
  const seen = useMemo(() => (address ? seenIds(address) : new Set<string>()), [address, view, shared]);
  if (!address) return null;
  const save = () => { const k = ident.keyFile(); if (k) download(k.name, k.text, "application/json"); };
  const on = (v: View) => !!view && view.kind === v.kind && (!("id" in v) || ("id" in view && view.id === v.id));
  const n = readyAll.length;
  return (
    <aside className="dash-left">
      <section className="keys" id="address">
        <p className="label">{kind === "qorex" ? "QoreX wallet" : "Key in this browser"}</p>
        <Addr a={address} />
        <p className="side-status"><span>Ready</span><span className="dot" aria-hidden>·</span><button className="link-sm" onClick={save}>Save my key file</button></p>
        {kind === "local" && ident.qorexAvailable && (
          <div className="calm side-note">
            <p>QoreX found.</p>
            <button className="link-sm" onClick={() => void ident.connectQorex()}>Use your QoreX wallet</button>
          </div>
        )}
        {n > 0 && <button className="side-ready" onClick={() => pick({ kind: "file", id: readyAll[0]!.fileId })}>{n} {n === 1 ? "teammate" : "teammates"} ready to add</button>}
      </section>
      <div className="files" role="tablist" aria-label="Files" aria-orientation="vertical">
        <p className="label">Your files</p>
        {mine.length === 0 && <p className="muted small">None yet.</p>}
        {mine.map((s) => {
          const f = parseCoffer(s.text);
          const r = readyAll.filter((w) => w.fileId === f.id).length;
          const twin = mine.some((o) => o !== s && ownerOf(o) && parseCoffer(o.text).name === f.name);
          return (
            <button key={f.id} role="tab" aria-selected={on({ kind: "file", id: f.id })} className="file-row" onClick={() => pick({ kind: "file", id: f.id })}>
              <span className="mono file-name">{f.name}.coffer{twin ? <span className="dim"> #{f.id.slice(0, 4)}</span> : null}</span>
              <span className="file-meta">{[`${f.readers.length} ${f.readers.length === 1 ? "reader" : "readers"}`, ago(s.changed), r ? `${r} ready to add` : ""].filter(Boolean).join(" · ")}</span>
            </button>
          );
        })}
        {(shared.length > 0 || mine.length === 0) && (
          <>
            <p className="label label-gap">Shared with you</p>
            {shared.length === 0 && <p className="muted small">{chainRead ? "Nothing yet." : "Looking on QoreChain…"}</p>}
            {shared.map((d) => {
              const can = d.readers.includes(address);
              const twin = shared.some((o) => o !== d && o.name === d.name);
              const fresh = can && !seen.has(d.id);
              return (
                <button key={d.id} role="tab" aria-selected={on({ kind: "shared", id: d.id })} className="file-row" onClick={() => pick({ kind: "shared", id: d.id })}>
                  <span className="mono file-name">{d.name}.coffer{twin ? <span className="dim"> #{d.id.slice(0, 4)}</span> : null}{fresh ? <span className="new-tag">New</span> : null}</span>
                  <span className="file-meta">from {short(d.owner, 6, 4)} · {can ? "You can open it" : "You were removed"}</span>
                </button>
              );
            })}
          </>
        )}
        <button role="tab" aria-selected={on({ kind: "seal" })} className="btn-outline btn-block" onClick={() => pick({ kind: "seal" })}>Seal a file</button>
        <button role="tab" aria-selected={on({ kind: "open" })} className="file-row file-open" onClick={() => pick({ kind: "open" })}>
          <span className="file-name">Open a file</span>
          <span className="file-meta">Paste or drop a .env.coffer</span>
        </button>
      </div>
      <details className="raw side-details">
        <summary>Details</summary>
        <dl className="facts">
          <div><dt>Full address</dt><dd className="mono">{address}</dd></div>
          {status?.card.state === "ours" && <div><dt>Card on QoreChain</dt><dd className="mono">block {status.card.height}</dd></div>}
          {status && <div><dt>Signing key (ML-DSA-87)</dt><dd>{status.pq ? "On QoreChain" : "Not yet"}</dd></div>}
          {status && kind === "local" && <div><dt>Balance</dt><dd className="mono">{qor(status.uqor)} test QOR</dd></div>}
        </dl>
        <div className="acts">
          {kind === "qorex" && ident.hasBrowserKey && <button className="link-sm" onClick={() => void ident.chooseBrowser()}>Use the key in this browser</button>}
          <KeyFilePicker className="link-sm" label="Load a key file" onText={async (t) => { setErr(null); try { await ident.loadKeyFile(t); } catch (e) { setErr(e); } }} />
          {kind === "qorex"
            ? <button className="link-sm" onClick={() => ident.disconnect()}>Disconnect QoreX</button>
            : <button className="link-sm" onClick={() => { if (confirm("Remove this key from this browser? Without your key file you can't open files shared with this address.")) ident.forgetKey(); }}>Remove this key</button>}
        </div>
        {err !== null && <Problem error={err} />}
      </details>
    </aside>
  );
}

/** While an invite is open: wait for the owner to add this address (with `for`), or send them the address (without). */
function InvitePanel({ invite, onDone }: { invite: Invite; onDone: () => void }) {
  const { address } = useIdentity();
  if (!address) return null;
  if (invite.for) {
    return (
      <section className="panel" id="invited" aria-labelledby="h-invited">
        <h2 id="h-invited" className="h-section">Done.</h2>
        <p className="lead"><span className="mono">{short(invite.owner, 8, 4)}</span> can add you now. This page opens the file as soon as they do.</p>
        <div className="progress" aria-live="polite">
          <span className="prog-bar" aria-hidden><span className="indeterminate" /></span>
          <p className="prog-line mono">Checking QoreChain every few seconds…</p>
        </div>
        <div><button className="link" onClick={onDone}>Go to my files</button></div>
      </section>
    );
  }
  return (
    <section className="panel" id="invited" aria-labelledby="h-invited">
      <h2 id="h-invited" className="h-section">You're set up.</h2>
      <p className="lead">Now send <span className="mono">{short(invite.owner, 8, 4)}</span> your address. The file opens here as soon as they add you.</p>
      <p className="addr-box mono">{address}</p>
      <div className="actions">
        <CopyAction className="btn" text={address} label="Copy my address" done="Address copied" />
        <button className="link" onClick={onDone}>Go to my files</button>
      </div>
    </section>
  );
}

// ---- seal a file ------------------------------------------------------------------

function readHint(): ImportHint | null {
  try { const t = sessionStorage.getItem(IMPORT_KEY); return t ? JSON.parse(t) : null; } catch { return null; }
}

/** The three steps of using Coffer, shown until the first file exists. */
function Flow({ at }: { at: number }) {
  const steps = ["Paste your .env", "Seal it", "Share it by address"];
  return (
    <ol className="flow" aria-label="Steps">
      {steps.map((t, i) => (
        <li key={t} className={i + 1 === at ? "on" : i + 1 < at ? "done" : ""} aria-current={i + 1 === at ? "step" : undefined}><b>{i + 1 < at ? "✓" : i + 1}</b>{t}</li>
      ))}
    </ol>
  );
}

/** Steps of one change: build and sign it, then record it on QoreChain. Nothing is kept unless both work. */
async function signAndRecord<T extends { text: string }>(
  log: ReturnType<typeof useLog>, wallet: boolean, doing: string, build: () => Promise<T>,
): Promise<{ r: T; rec: Recorded }> {
  const stop = onWalletAsk((n) => { if (n > 0) log.step("Approve it in QoreX"); });
  try {
    log.step(doing);
    const r = await build();
    stop();
    log.step(wallet ? "Signed. Recording it on QoreChain" : "Recording it on QoreChain");
    const rec = await recordHead(r.text);
    log.done("Recorded on QoreChain", rec.hash);
    return { r, rec };
  } finally {
    stop();
  }
}

function SealPanel({ first, onSealed }: { first: boolean; onSealed: (text: string, rec: Recorded) => void }) {
  const { owner, keys: sealKeys, kind } = useIdentity();
  const [hint, setHint] = useState<ImportHint | null>(readHint);
  const [tab, setTab] = useState<"plain" | "dotenvx">(hint?.kind === "dotenvx" ? "dotenvx" : "plain");
  const [env, setEnv] = useState("");
  const [envKeys, setEnvKeys] = useState("");
  const [hintErr, setHintErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const log = useLog();
  const name = hint ? hint.path.split("/").pop() || ".env" : ".env";
  // the dotenvx reader (secp256k1 + ECIES) loads only when a dotenvx file is in play
  const [dx, setDx] = useState<typeof import("../../../src/core/dotenvx.ts") | null>(null);
  const needsDx = tab === "dotenvx" || /DOTENV_PUBLIC_KEY|encrypted:/.test(env);
  useEffect(() => { if (needsDx && !dx) import("../../../src/core/dotenvx.ts").then(setDx).catch(() => {}); }, [needsDx, dx]);

  useEffect(() => {
    if (!hint) return;
    const url = `https://raw.githubusercontent.com/${hint.repo}/${encodeURIComponent(hint.branch)}/${hint.path.split("/").map(encodeURIComponent).join("/")}`;
    fetch(url).then(async (r) => { if (!r.ok) throw new Error(String(r.status)); setEnv(await r.text()); setHintErr(false); }).catch(() => setHintErr(true));
  }, [hint]);

  const preview = useMemo((): { entries: DotenvEntry[] | null; note: string | null } => {
    if (!env.trim()) return { entries: null, note: null };
    if (needsDx && !dx) return { entries: null, note: "Reading the file…" };
    const scan = dx ? dx.scanDotenvx(env) : { isDotenvx: false, encryptedKeys: [] as string[] };
    if (tab === "plain") {
      if (scan.isDotenvx) return { entries: null, note: "This file is locked by dotenvx. Press \"Bring that file over\" below the box to unlock and move its values." };
      const e = parseDotenv(env);
      return { entries: e, note: e.length ? null : "No NAME=value lines found." };
    }
    if (!scan.isDotenvx) return { entries: null, note: "This file isn't locked by dotenvx. Use \"Paste a .env\" instead." };
    if (!envKeys.trim()) return { entries: null, note: `${scan.encryptedKeys.length} locked values found. Add the matching .env.keys to unlock them here.` };
    try { return { entries: dx!.importDotenvx(env, envKeys).entries, note: null }; }
    catch { return { entries: null, note: "That .env.keys doesn't match this file." }; }
  }, [env, envKeys, tab, dx, needsDx]);

  async function seal() {
    if (!owner || !sealKeys || !preview.entries?.length) return;
    setBusy(true); setErr(null); log.reset();
    try {
      const { r, rec } = await signAndRecord(log, owner.kind === "wallet", "Sealing in your browser",
        async () => ({ text: await work<string>("create", { name, owner, keys: sealKeys, env: serializeDotenv(preview.entries!) }) }));
      setEnv(""); setEnvKeys("");
      try { sessionStorage.removeItem(IMPORT_KEY); } catch { /* storage blocked */ }
      onSealed(r.text, rec);
    } catch (e) {
      log.fail();
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" id="seal" aria-labelledby="h-seal">
      <h2 id="h-seal" className="h-section">Seal a file.</h2>
      {first && <Flow at={preview.entries?.length ? 2 : 1} />}
      {hint && (
        <div className="hintline">
          <p>Moving <span className="mono">{hint.path}</span> from <span className="mono">{hint.repo}</span>.{" "}
            {hint.kind === "plain" ? "It's public right now, so change these values at each provider after sealing the new ones." :
              hint.kind === "dotenvx" ? "We filled in the file from GitHub. Add your .env.keys below; it never leaves this page." : ""}</p>
          <button className="link" onClick={() => { try { sessionStorage.removeItem(IMPORT_KEY); } catch { /* */ } setHint(null); setEnv(""); }}>Clear</button>
        </div>
      )}
      {hintErr && <Problem text={`Couldn't fetch ${hint?.path ?? "the file"} from GitHub. Paste it below instead.`} />}
      {tab === "dotenvx" && (
        <p className="muted">dotenvx locks a .env with a key that a quantum computer could break. Paste the locked file and its .env.keys: Coffer unlocks it here in your browser and seals it again. <button className="link-sm" onClick={() => setTab("plain")}>Back to a plain .env</button></p>
      )}
      <DropText id="envtext" label={tab === "plain" ? "Your .env" : "Your dotenvx .env"} value={env} onChange={setEnv} placeholder={"NAME=value\nOTHER_NAME=value"} />
      {tab === "plain" && <p className="muted small">Already use dotenvx? <button className="link-sm" onClick={() => setTab("dotenvx")}>Bring that file over</button></p>}
      {tab === "dotenvx" && (
        <>
          <DropText id="keystext" label="Its .env.keys" value={envKeys} onChange={setEnvKeys} rows={3} placeholder="DOTENV_PRIVATE_KEY=…" />
          <p className="muted small">Unlocked here in your browser. Nothing is sent anywhere.</p>
        </>
      )}
      {preview.note && <p className="muted">{preview.note}</p>}
      {preview.entries && preview.entries.length > 0 && (
        <div><p className="label">{preview.entries.length} {preview.entries.length === 1 ? "value" : "values"} to seal</p><Chips names={preview.entries.map((e) => e.key)} /></div>
      )}
      <div><button className="btn" disabled={busy || !preview.entries?.length} onClick={seal}>{busy ? "Sealing" : `Seal into ${name}.coffer`}</button></div>
      <Progress lines={log.lines} />
      {err !== null && <Problem error={err} />}
      <p className="muted small">{kind === "qorex" ? "QoreX asks you to approve once. No fee. " : ""}Values stay in this page's memory only. They are never saved in this browser.</p>
    </section>
  );
}

// ---- the values, as the document -----------------------------------------------------

/** Names with black bars; a click shows that one value until focus moves on. Copy works without showing it. */
function DocValues({ entries }: { entries: DotenvEntry[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="doc-values">
      {entries.map((e) => (
        <div key={e.key} className="env-line doc-line">
          <span className="env-k">{e.key}=</span>
          <button className="reveal-bar" onClick={() => setOpen(e.key)} onBlur={() => setOpen((o) => (o === e.key ? null : o))} aria-label={open === e.key ? `${e.key}, shown` : `Show ${e.key}`}>
            {open === e.key ? <span className="mono">{e.value || "(empty)"}</span> : <Bar w={Math.min(22, Math.max(8, Math.round(e.value.length * 0.6)))} />}
          </button>
          <button className="copy doc-copy" onClick={async () => { if (await copyText(e.value)) { setCopied(e.key); setTimeout(() => setCopied(null), 1400); } }} aria-label={`Copy ${e.key}`}>{copied === e.key ? "Copied" : "Copy"}</button>
        </div>
      ))}
      <p className="sheet-note">Click a bar to see that value. It closes when you click away.</p>
    </div>
  );
}

/** The owner's view: opened with this browser's key. */
function OwnerValues({ text }: { text: string }) {
  const { keys } = useIdentity();
  const [entries, setEntries] = useState<DotenvEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    if (keys) work<DotenvEntry[]>("open", { text, keys }).then((e) => live && setEntries(e)).catch(() => live && setEntries([]));
    return () => { live = false; };
  }, [text, keys]);
  if (!entries) return <p className="sheet-wait">Opening with your key…</p>;
  return <DocValues entries={entries} />;
}

/** QoreChain's record of this file, read live. */
function HeadNow({ fileId, epoch }: { fileId: string; epoch: bigint }) {
  const [head, setHead] = useState<ChainHead | null | undefined>(undefined);
  const [err, setErr] = useState(false);
  useEffect(() => { let live = true; setHead(undefined); setErr(false); readHead(fileId).then((h) => live && setHead(h)).catch(() => live && setErr(true)); return () => { live = false; }; }, [fileId, epoch]);
  if (err) return <p className="muted small">QoreChain can't be reached right now.</p>;
  if (head === undefined) return <p className="muted small">Reading QoreChain…</p>;
  if (!head) return <p className="muted small">QoreChain has no record of this file.</p>;
  return (
    <dl className="facts">
      <div><dt>On QoreChain now</dt><dd className="mono">epoch {String(head.epoch)} · version {String(head.version)}</dd></div>
      <div><dt>Recorded in block</dt><dd className="mono">{head.height}</dd></div>
      <div><dt>This copy</dt><dd className={head.epoch === epoch ? "ok" : "no"}>{head.epoch === epoch ? "Matches QoreChain" : "Older than QoreChain's"}</dd></div>
    </dl>
  );
}

// ---- a file shared with you: straight from QoreChain ------------------------------------

type SharedState = { s: "checking" } | { s: "ok"; entries: DotenvEntry[] } | { s: "refused"; code?: string; msg: string } | { s: "nokey" } | { s: "removed" };

function SharedView({ d }: { d: Delivered }) {
  const { address, keys } = useIdentity();
  const can = !!address && d.readers.includes(address);
  useEffect(() => { if (address) markSeen(address, d.id); }, [address, d.id]);
  const [st, setSt] = useState<SharedState>({ s: "checking" });
  useEffect(() => {
    let live = true;
    if (!can) { setSt({ s: "removed" }); return; }
    if (!keys) { setSt({ s: "nokey" }); return; }
    setSt({ s: "checking" });
    (async () => {
      try {
        await work("check", { text: d.text });
        const entries = await work<DotenvEntry[]>("open", { text: d.text, keys });
        if (live) setSt({ s: "ok", entries });
      } catch (e) {
        if (live) setSt({ s: "refused", code: errCode(e), msg: errText(e) });
      }
    })();
    return () => { live = false; };
  }, [d.id, d.epoch, d.text, can, keys]);

  const stamp = st.s === "ok" ? <Stamp>Opened</Stamp> : st.s === "removed" ? <Stamp tone="red">Removed</Stamp> : st.s === "refused" ? <Stamp tone="red">Refused</Stamp> : null;
  const line = st.s === "ok" ? "Checked against QoreChain and opened with your key."
    : st.s === "checking" ? "Checking it against QoreChain…"
      : st.s === "removed" ? "You were removed. Its owner sealed a new version without you."
        : st.s === "nokey" ? "This browser doesn't have your key. Load your key file from Details."
          : explain(st.code, st.msg);
  return (
    <div className="file" aria-labelledby="h-shared">
      <Sheet className="sheet-file" left={<span id="h-shared">{d.name}.coffer</span>} right={`from ${short(d.owner, 6, 4)}`} stamp={stamp}>
        {st.s === "ok" ? <DocValues entries={st.entries} /> : <p className="sheet-wait">{line}</p>}
      </Sheet>
      <p className="file-line">
        <span>{st.s === "removed" ? `From ${short(d.owner, 6, 4)}.` : `Shared with you by ${short(d.owner, 6, 4)}.`}</span>
        {d.hash && <><span className="dot" aria-hidden>·</span><a className="link-sm" href={explorerTx(d.hash)} target="_blank" rel="noreferrer">Recorded on QoreChain</a></>}
        <span className="dot" aria-hidden>·</span><button className="link-sm" onClick={() => download(`${d.name}.coffer`, d.text)}>Download</button>
      </p>
      <details className="raw">
        <summary>Details</summary>
        <dl className="facts">
          <div><dt>File id</dt><dd className="mono">{d.id}</dd></div>
          <div><dt>Owner</dt><dd className="mono">{d.owner}</dd></div>
          <div><dt>On QoreChain</dt><dd className="mono">epoch {String(d.epoch)} · version {String(d.version)} · block {d.height}</dd></div>
          <div><dt>In a terminal</dt><dd className="mono">coffer pull {d.id}</dd></div>
        </dl>
        {d.hash && <RecordFacts hash={d.hash} block={d.height} />}
        {st.s === "refused" && <p className="mono small">{st.code ? `${st.code}: ` : ""}{st.msg}</p>}
      </details>
    </div>
  );
}

// ---- one of your files, as the document ---------------------------------------------------

type TeammateAnswer = { opened: true; keys: string[]; epoch: number | string; version: number | string; verified: boolean } | { opened: false; code?: string; error: string };
type Outcome = { kind: "ask"; answer: TeammateAnswer; label: "first" | "again" | "old" } | { kind: "revoke"; rotate: string[]; tx: string; block?: number };

const REFUSED: Record<string, string> = {
  NOT_A_READER: "Ada isn't on the list any more, so her key opens nothing.",
  STALE: "This is an old copy. QoreChain has a newer one, so Ada won't use it.",
  BAD_SIGNATURE: "Someone changed this file by hand.",
  UNRECORDED: "QoreChain has no record of this version.",
  FORKED: "QoreChain has a different reader list for this version.",
  OWNER_MISMATCH: "QoreChain says this file belongs to someone else.",
};

let teammateCache: Promise<string> | null = null;
function getTeammate(): Promise<string> {
  teammateCache ??= api<{ address: string }>("/api/teammate").then((r) => {
    if (!r.address) throw new Error("Ada, the demo teammate, isn't available right now.");
    return r.address;
  });
  teammateCache.catch(() => { teammateCache = null; });
  return teammateCache;
}

const ASKS = new Set(["first", "again", "old"]);
const ADA = new Set(["ada", "remove-ada", "first", "again", "old"]);

function FileDetail({ stored, ready, onChange }: { stored: Stored; ready: Record<string, boolean>; onChange: (patch: Partial<Stored>) => void }) {
  const { address, owner, keys } = useIdentity();
  const file = useMemo(() => parseCoffer(stored.text), [stored.text]);
  const [teammate, setTeammate] = useState<string | null>(null);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [note, setNoteRaw] = useState<{ text: string; about?: string } | null>(null);
  const setNote = (text: string | null, about?: string) => setNoteRaw(text ? { text, about } : null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [changed, setChanged] = useState<string[]>([]);
  const [adaOpen, setAdaOpen] = useState(false);
  const log = useLog();
  const wallet = owner?.kind === "wallet";

  useEffect(() => { getTeammate().then(setTeammate).catch(() => {}); }, []);
  useEffect(() => { setOutcomes([]); setErr(null); setNote(null); log.reset(); }, [file.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // readers who made a new key since they were sealed in
  useEffect(() => { let live = true; changedReaders(stored.text).then((x) => live && setChanged(x)).catch(() => {}); return () => { live = false; }; }, [stored.text]);

  const waiting = useMemo(() => (stored.waiting ?? []).filter((a) => !file.readers.includes(a)), [stored.waiting, file.readers]);
  const readyHere = waiting.filter((a) => ready[a]);
  const isAda = (a: string) => !!teammate && a === teammate;
  const who = (a: string) => (isAda(a) ? "Ada" : short(a, 6, 4));
  const name = (a: string) => (a === address ? "You" : isAda(a) ? "Ada, demo teammate" : "Teammate");
  const mateIn = !!teammate && file.readers.includes(teammate);
  const mateRemoved = !!teammate && !mateIn && (stored.removed ?? []).includes(teammate);
  const entry = (what: string, rec: Recorded) => ({ tx: rec.hash, block: rec.block, log: [...(stored.log ?? []), { what, hash: rec.hash, block: rec.block, at: new Date().toISOString() }] });

  /** Seal the file to `a`: if they have no card yet, they wait on the list with an invite link. */
  const share = async (raw: string, key: string) => {
    const a = raw.trim();
    setErr(null); setNote(null); log.reset();
    if (!owner || !keys || !address) return;
    if (!isQorAddress(a)) { setErr(coded("BAD_ADDRESS", "not a qor1 address")); return; }
    if (a === file.owner) { setNote("That's your own address. You can already open this file."); return; }
    if (file.readers.includes(a) && !changed.includes(a)) { setNote("They can already open this file."); return; }
    setBusy(key);
    try {
      log.step("Looking for their card on QoreChain");
      if (!(await hasCard(a))) {
        log.reset();
        if (!waiting.includes(a)) onChange({ waiting: [...(stored.waiting ?? []), a] });
        const copied = await copyText(inviteLink(address, a, file.id));
        setNote(copied
          ? "They haven't opened Coffer yet. Their invite link is copied: send it to them. They connect QoreX and sign once, no fee."
          : "They haven't opened Coffer yet. Copy their invite link from the list and send it to them.", a);
        setAddr("");
        return;
      }
      const { r, rec } = await signAndRecord(log, wallet, "Sealing it to them", async () => ({ text: await work<string>("shareTo", { text: stored.text, owner, keys, addresses: [a] }) }));
      const again = file.readers.includes(a);
      onChange({
        text: r.text, ...entry(again ? `Sealed ${who(a)} in again` : `Shared with ${who(a)}`, rec),
        note: again ? `${who(a)} can open it again with their new key.` : `Shared with ${who(a)}. It shows up in their Coffer.`,
        removed: (stored.removed ?? []).filter((x) => x !== a), waiting: (stored.waiting ?? []).filter((x) => x !== a), rotate: undefined,
      });
      setChanged((c) => c.filter((x) => x !== a));
      setAddr("");
      toast(again ? `${who(a)} can open it again.` : `Shared with ${who(a)}. It's in their Coffer now.`);
    } catch (e) {
      log.fail();
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (a: string, key: string) => {
    if (!owner || !keys) return;
    setBusy(key); setErr(null); setNote(null); log.reset();
    try {
      const { r, rec } = await signAndRecord(log, wallet, "Sealing a new version without them",
        () => work<{ text: string; rotate: string[] }>("revoke", { text: stored.text, owner, keys, addresses: [a] }));
      onChange({
        text: r.text, old: stored.text, ...entry(`Removed ${who(a)}`, rec), note: `Removed ${who(a)}.`,
        removed: [...new Set([...(stored.removed ?? []), a])], rotate: isAda(a) ? undefined : { who: who(a), names: r.rotate },
      });
      if (isAda(a)) setOutcomes((o) => [...o, { kind: "revoke", rotate: r.rotate, tx: rec.hash, block: rec.block }]);
      toast(`Removed ${who(a)}. They can't open the new version.`);
    } catch (e) {
      log.fail();
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const ask = async (text: string, label: "first" | "again" | "old") => {
    setBusy(label); setErr(null);
    try {
      const answer = await api<TeammateAnswer>("/api/teammate/open", { body: { file: text } });
      setOutcomes((o) => [...o, { kind: "ask", answer, label }]);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const withAda = async (fn: (ada: string) => Promise<void>) => {
    try { const a = teammate ?? await getTeammate(); setTeammate(a); await fn(a); } catch (e) { setErr(e); }
  };

  const readers = [...file.readers].sort((a, b) => (a === file.owner ? -1 : b === file.owner ? 1 : 0));
  const removed = (stored.removed ?? []).filter((a) => !file.readers.includes(a));
  const adaBusy = !!busy && ADA.has(busy);
  const progress = busy && !ASKS.has(busy) && <Progress lines={log.lines} />;
  const problem = err !== null && <Problem error={err} plain />;
  return (
    <div className="file">
      {readyHere.map((a) => (
        <div key={a} className="ready-line" role="status">
          <p><span className="mono">{short(a, 8, 4)}</span> is ready.</p>
          <button className="btn" disabled={!!busy} onClick={() => void share(a, `seal-${a}`)}>{busy === `seal-${a}` ? "Adding" : "Add them"}</button>
        </div>
      ))}
      <section id="seal" aria-labelledby="h-file">
        <Sheet className="sheet-file" left={<span id="h-file">{file.name}.coffer</span>} right={`readers: ${file.readers.length}`} stamp={<Stamp>Sealed</Stamp>}>
          <OwnerValues text={stored.text} />
        </Sheet>
        <p className="file-line">
          <span>{stored.note ?? "Sealed. Safe to commit."}</span>
          {stored.tx && <><span className="dot" aria-hidden>·</span><a className="link-sm" href={explorerTx(stored.tx)} target="_blank" rel="noreferrer">Recorded on QoreChain</a></>}
          <span className="dot" aria-hidden>·</span><button className="link-sm" onClick={() => download(`${file.name}.coffer`, stored.text)}>Download</button>
        </p>
      </section>

      <section className="file-sec" id="share" aria-labelledby="h-to">
        <h3 id="h-to" className="label">Who can open it</h3>
        <ul className="to-list">
          {readers.map((a) => (
            <li key={a}>
              <span className="to-name">{a === file.owner ? "You, owner" : changed.includes(a) ? `${name(a)}, new key` : name(a)}</span>
              <Addr a={a} />
              {a === file.owner ? <span /> : changed.includes(a)
                ? <button className="link-sm" disabled={!!busy} onClick={() => void share(a, `again-${a}`)}>{busy === `again-${a}` ? "Sealing them in" : "Seal in again"}</button>
                : <button className="link-sm" disabled={!!busy} onClick={() => void remove(a, isAda(a) ? "remove-ada" : `remove-${a}`)}>{busy === `remove-${a}` || (isAda(a) && busy === "remove-ada") ? "Removing" : "Remove"}</button>}
            </li>
          ))}
          {waiting.map((a) => (
            <li key={a} className="to-waiting">
              <span className="to-name">{ready[a] ? "Ready to add" : "Invited, not set up yet"}</span>
              <Addr a={a} />
              {ready[a] ? <span className="small ok">ready</span> : <CopyAction className="link-sm" text={address ? inviteLink(address, a, file.id) : ""} label="Copy invite link" done="Copied" />}
            </li>
          ))}
          {removed.map((a) => (
            <li key={a} className="to-removed">
              <span className="to-name struck">{name(a)}</span>
              <span className="mono struck">{short(a, 8, 4)}</span>
              <span className="no small">removed</span>
            </li>
          ))}
          <li className="add-row">
            <form className="line-form" onSubmit={(e) => { e.preventDefault(); if (addr.trim()) void share(addr, "share"); }}>
              <label htmlFor="addr" className="sr">Add someone by their QoreChain address</label>
              <input id="addr" className="mono" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Add a teammate's QoreChain address" spellCheck={false} autoComplete="off" />
              <button className={readyHere.length ? "btn-outline" : "btn"} disabled={!!busy || !addr.trim()}>{busy === "share" ? "Adding" : "Add"}</button>
            </form>
          </li>
        </ul>
        {!adaBusy && progress}
        {note && !(note.about && (ready[note.about] || !waiting.includes(note.about))) && <p className="row-note" role="status">{note.text}</p>}
        {!adaBusy && problem}
        {!mateIn && !mateRemoved && file.readers.length === 1 && !waiting.length && (
          <p className="row-note muted">No teammate handy? <button className="link-sm" disabled={!!busy} onClick={() => { setAdaOpen(true); void withAda((a) => share(a, "ada")); }}>Add Ada</button>, our demo teammate.</p>
        )}
        {stored.rotate && (
          <div className="row-note">
            <p>{stored.rotate.who} can't open the new version. Change {stored.rotate.names.length === 1 ? "this value" : "these values"} at the provider, since they may have read {stored.rotate.names.length === 1 ? "it" : "them"} before:</p>
            <Chips names={stored.rotate.names} />
          </div>
        )}
      </section>

      <details className="file-sec ada" id="prove" open={adaOpen} onToggle={(e) => setAdaOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>Test it with Ada, a demo teammate</summary>
        <p className="muted">Ada is a demo teammate run by Coffer. She checks the file against QoreChain the way the CLI does, and tells you only the names she could read.</p>
        <div className="prove-acts">
          <button className="btn-outline" disabled={!!busy || mateIn} onClick={() => void withAda((a) => share(a, "ada"))}>{busy === "ada" ? "Sharing with Ada" : mateIn ? "Shared with Ada" : "Share with Ada"}</button>
          <button className="btn-outline" disabled={!!busy || !mateIn} onClick={() => void ask(stored.text, "first")}>{busy === "first" ? "Asking Ada" : "Ask Ada to open it"}</button>
          <button className="btn-outline" disabled={!!busy || !mateIn} onClick={() => void withAda((a) => remove(a, "remove-ada"))}>{busy === "remove-ada" ? "Removing Ada" : "Remove Ada"}</button>
          <button className="btn-outline" disabled={!!busy || !mateRemoved} onClick={() => void ask(stored.text, "again")}>{busy === "again" ? "Asking Ada" : "Ask Ada again"}</button>
          <button className="btn-outline" disabled={!!busy || !mateRemoved || !stored.old} onClick={() => stored.old && void ask(stored.old, "old")}>{busy === "old" ? "Sending" : "Send Ada the old copy"}</button>
        </div>
        {adaBusy && progress}
        {adaBusy && problem}
        <div className="outcomes">
          {outcomes.map((o, i) => <OutcomeView key={i} o={o} />)}
        </div>
      </details>

      <details className="raw file-raw">
        <summary>Details</summary>
        <dl className="facts">
          <div><dt>File id</dt><dd className="mono">{file.id}</dd></div>
          <div><dt>Epoch</dt><dd className="mono">{String(file.epoch)}</dd></div>
          <div><dt>Version</dt><dd className="mono">{String(file.version)}</dd></div>
        </dl>
        <HeadNow fileId={file.id} epoch={file.epoch} />
        {stored.tx && <RecordFacts hash={stored.tx} block={stored.block} />}
        {(stored.log ?? []).length > 0 && (
          <ol className="records">
            {[...(stored.log ?? [])].reverse().map((h) => (
              <li key={h.hash}>
                <span>{new Date(h.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                <span>{h.what}</span>
                <span className="mono">{h.block !== undefined ? `block ${h.block}` : ""}</span>
                <TxLink hash={h.hash} label="view" />
              </li>
            ))}
          </ol>
        )}
        <Log lines={log.lines} />
        <pre className="mono">{stored.text}</pre>
      </details>
    </div>
  );
}

function OutcomeView({ o }: { o: Outcome }) {
  if (o.kind === "revoke") {
    return (
      <div className="outcome rotate">
        <Stamp tone="ink">Removed</Stamp>
        <p>Ada can't open the new version. Change {o.rotate.length === 1 ? "this value" : `these ${o.rotate.length} values`} at the provider: she may have read {o.rotate.length === 1 ? "it" : "them"} before.</p>
        <Chips names={o.rotate} />
        <details className="steps"><summary>Details</summary><p>Recorded on QoreChain: <TxLink hash={o.tx} />{o.block !== undefined ? `, block ${o.block}` : ""}</p></details>
      </div>
    );
  }
  const a = o.answer;
  const what = o.label === "old" ? "The old copy, sent to Ada" : o.label === "again" ? "Asked Ada again" : "Asked Ada";
  return a.opened ? (
    <div className="outcome answer">
      <p className="label">{what}</p>
      <Stamp>Opened</Stamp>
      <p>Ada opened it and read {a.keys.length} {a.keys.length === 1 ? "name" : "names"}. The server reports names only, never values.</p>
      <Chips names={a.keys} />
      <details className="steps"><summary>Details</summary><p className="mono">epoch {String(a.epoch)} · version {String(a.version)} · checked against QoreChain</p></details>
    </div>
  ) : (
    <div className="outcome answer">
      <p className="label">{what}</p>
      <Stamp tone="red">Refused</Stamp>
      <p>{(a.code && REFUSED[a.code]) ?? a.error}</p>
      <details className="steps"><summary>Details</summary><p className="mono">{a.code ? `${a.code}: ` : ""}{a.error}</p></details>
    </div>
  );
}
