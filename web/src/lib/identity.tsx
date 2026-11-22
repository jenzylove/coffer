// Who you are in Coffer, with no seed phrase in the first minute.
//
// QoreX (primary): the wallet's qor1 address. It signs cards and changes with
// signArbitrary (no fee, no transaction). The keys that open files come from a
// random 32 byte seed kept in this browser (`coffer.seal.<address>`).
//
// This browser (secondary): a key made here (`coffer.identity`), registered on
// chain by the Coffer relayer. Nothing about it is shown up front.
//
// Either way "Save my key file" keeps a private copy, and "Load my key file"
// brings it back.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SealKeyPair } from "@qorechain/qoreseal";
import type { MessageSignature } from "@qorechain/qoresign";
import type { Identity } from "../../../src/core/identity.ts";
import { CHAIN, b64url, coded, fromB64url, short, sleep } from "./net.ts";
import { setWallet, work } from "./crypto.ts";
import { status as readStatus, type Status } from "./chain.ts";

export type Kind = "qorex" | "local";
/** Who signs: a key in the worker, or the wallet through the page. */
export type OwnerRef = { kind: "local"; id: Identity } | { kind: "wallet"; address: string };

const KIND = "coffer.kind";
const PHRASE = "coffer.identity";
const seedKey = (a: string) => `coffer.seal.${a}`;

const store = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

interface QorexNative {
  enable(chainId: string): Promise<unknown>;
  getKey(chainId: string): Promise<{ bech32Address: string }>;
  signArbitrary(chainId: string, signer: string, data: string): Promise<MessageSignature>;
}
const qorex = (): QorexNative | null => ((window as unknown as { qorex?: { native?: QorexNative } }).qorex?.native ?? null);
/** Extensions can inject a moment after the page starts: look for a little while. */
async function findQorex(ms: number): Promise<QorexNative | null> {
  for (let t = 0; t < ms; t += 100) { const q = qorex(); if (q) return q; await sleep(100); }
  return qorex();
}

function connectFailure(e: unknown): Error {
  const x = e as { message?: string; code?: unknown };
  const msg = String(x?.message ?? e ?? "");
  if (x?.code === 4001 || /reject|denied|cancel|closed|declin|dismiss/i.test(msg)) return coded("CONNECT_REJECTED", "You closed QoreX without connecting. Nothing changed.");
  return coded("CONNECT_FAILED", msg ? `QoreX couldn't connect: ${msg}` : "QoreX couldn't connect.");
}

const WARNING = "PRIVATE KEY. This file opens every Coffer file shared with this address. Keep it private: never commit it, never send it to anyone.";

/** A 24 word phrase in an older Coffer backup (a .txt file). */
function phraseIn(text: string): string | null {
  const line = text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).find((l) => /^[a-z]+(\s+[a-z]+){23}$/.test(l));
  return line ? line.split(/\s+/).join(" ") : null;
}

interface Ctx {
  kind: Kind | null;
  address: string | null;
  /** The keys that open files sealed to this address, if this browser has them. */
  keys: SealKeyPair | null;
  /** The browser key (kind local). */
  id: Identity | null;
  owner: OwnerRef | null;
  /** A short sentence while connecting or making keys. */
  busy: string | null;
  walletMissing: boolean;
  /** QoreX is installed in this browser (null while looking). */
  qorexAvailable: boolean | null;
  /** A key made in this browser is stored here (it can be switched back to). */
  hasBrowserKey: boolean;
  error: unknown;
  status: Status | null;
  statusError: unknown;
  /** The person clicked Connect (or Use this browser) in this visit: setup may ask for the card at once. */
  justConnected: boolean;
  connectQorex: () => Promise<string | null>;
  chooseBrowser: () => Promise<void>;
  /** QoreX: keys for this address, made now if this browser has none. */
  ensureKeys: () => Promise<SealKeyPair>;
  /** QoreX: a fresh key for this address (after a card was signed elsewhere). */
  newKey: () => Promise<SealKeyPair>;
  loadKeyFile: (text: string) => Promise<void>;
  keyFile: () => { name: string; text: string } | null;
  refresh: () => Promise<Status | null>;
  disconnect: () => void;
  forgetKey: () => void;
}

const IdentityContext = createContext<Ctx | null>(null);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [kind, setKind] = useState<Kind | null>(() => (store.get(KIND) as Kind | null) ?? (store.get(PHRASE) ? "local" : null));
  const [address, setAddress] = useState<string | null>(null);
  const [keys, setKeys] = useState<SealKeyPair | null>(null);
  const [id, setId] = useState<Identity | null>(null);
  const [busy, setBusy] = useState<string | null>(() => (kind === "local" ? "Opening your key." : kind === "qorex" ? "Connecting to QoreX." : null));
  const [walletMissing, setWalletMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [justConnected, setJustConnected] = useState(false);
  const [qorexAvailable, setQorexAvailable] = useState<boolean | null>(null);
  const [hasBrowserKey, setHasBrowserKey] = useState(() => !!store.get(PHRASE));
  const addrRef = useRef<string | null>(null);
  const keysRef = useRef<SealKeyPair | null>(null);

  const putKeys = (k: SealKeyPair | null) => { keysRef.current = k; setKeys(k); };
  const putAddress = (a: string | null) => { addrRef.current = a; setAddress(a); };

  const refresh = useCallback(async () => {
    const a = addrRef.current;
    if (!a) return null;
    try {
      const st = await readStatus(a, keysRef.current);
      if (addrRef.current !== a) return null;
      setStatus(st);
      setStatusError(null);
      return st;
    } catch (e) {
      if (addrRef.current === a) setStatusError(e);
      return null;
    }
  }, []);

  /** Use this QoreX address: its signer, and its keys if this browser has them. */
  const takeWallet = useCallback(async (q: QorexNative, a: string) => {
    setWallet({ address: a, sign: (chainId, signer, text) => q.signArbitrary(chainId, signer, text) });
    const seed = store.get(seedKey(a));
    putKeys(seed ? await work<SealKeyPair>("sealKeys", { seed: fromB64url(seed) }) : null);
    setId(null);
    setStatus(null);
    setStatusError(null);
    putAddress(a);
  }, []);

  const takeLocal = useCallback(async (phrase: string) => {
    const next = await work<Identity>("identity", { phrase });
    setWallet(null);
    setId(next);
    putKeys(next.sealKeys);
    setStatus(null);
    setStatusError(null);
    putAddress(next.address);
  }, []);

  // on load: open the browser key, or reconnect QoreX without a prompt
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (kind === "local") {
          const p = store.get(PHRASE);
          if (!p) { store.set(KIND, null); if (live) setKind(null); return; }
          await takeLocal(p);
        } else if (kind === "qorex") {
          const q = await findQorex(1500);
          if (!q) { if (live) setWalletMissing(true); return; }
          const k = await q.getKey(CHAIN);
          if (live) await takeWallet(q, k.bech32Address);
        }
      } catch { /* not connected any more: the connect screen shows */ }
      finally { if (live) setBusy(null); }
    })();
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (address) void refresh(); }, [address, refresh]);

  useEffect(() => {
    let live = true;
    findQorex(1500).then((q) => { if (live) setQorexAvailable(!!q); });
    return () => { live = false; };
  }, []);

  // QoreX does not announce account changes: read the key again when the page comes back
  useEffect(() => {
    if (kind !== "qorex" || !address) return;
    const on = async () => {
      if (document.hidden) return;
      const q = qorex();
      if (!q) return;
      try { const k = await q.getKey(CHAIN); if (k.bech32Address !== addrRef.current) await takeWallet(q, k.bech32Address); } catch { /* keep the current one */ }
    };
    addEventListener("focus", on);
    document.addEventListener("visibilitychange", on);
    return () => { removeEventListener("focus", on); document.removeEventListener("visibilitychange", on); };
  }, [kind, address, takeWallet]);

  const connectQorex = useCallback(async () => {
    setError(null);
    const q = await findQorex(400);
    if (!q) { setWalletMissing(true); setQorexAvailable(false); return null; }
    setWalletMissing(false);
    setQorexAvailable(true);
    setBusy("Waiting for QoreX.");
    try {
      await q.enable(CHAIN);
      const k = await q.getKey(CHAIN);
      await takeWallet(q, k.bech32Address);
      store.set(KIND, "qorex");
      setKind("qorex");
      setJustConnected(true);
      return k.bech32Address;
    } catch (e) {
      setError(connectFailure(e));
      return null;
    } finally {
      setBusy(null);
    }
  }, [takeWallet]);

  const chooseBrowser = useCallback(async () => {
    setError(null);
    setBusy("Making a key in this browser.");
    try {
      const phrase = store.get(PHRASE) ?? await work<string>("newPhrase");
      store.set(PHRASE, phrase);
      setHasBrowserKey(true);
      await takeLocal(phrase);
      store.set(KIND, "local");
      setKind("local");
      setJustConnected(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }, [takeLocal]);

  const makeKeys = useCallback(async (fresh: boolean) => {
    const a = addrRef.current;
    if (!a) throw coded("WALLET_GONE", "QoreX isn't connected.");
    if (!fresh && keysRef.current) return keysRef.current;
    const old = store.get(seedKey(a));
    if (old) store.set(`${seedKey(a)}.prev`, old); // never lose a key outright
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const k = await work<SealKeyPair>("sealKeys", { seed });
    store.set(seedKey(a), b64url(seed));
    putKeys(k);
    return k;
  }, []);
  const ensureKeys = useCallback(() => makeKeys(false), [makeKeys]);
  const newKey = useCallback(() => makeKeys(true), [makeKeys]);

  const loadKeyFile = useCallback(async (text: string) => {
    setError(null);
    let j: { app?: string; kind?: string; address?: string; seed?: string; phrase?: string } | null = null;
    try { j = JSON.parse(text); } catch { /* maybe an older text backup */ }
    if (j && j.app === "coffer" && j.kind === "qorex" && typeof j.seed === "string" && typeof j.address === "string") {
      let a = kind === "qorex" ? addrRef.current : null;
      if (!a) a = await connectQorex();
      if (!a) throw coded("WALLET_GONE", "Connect QoreX first, then load the key file.");
      if (j.address !== a) throw coded("KEYFILE_OTHER", `This key file is for ${short(j.address, 8, 4)}, but QoreX is on ${short(a, 8, 4)}. Switch the account in QoreX and try again.`);
      let k: SealKeyPair;
      try { k = await work<SealKeyPair>("sealKeys", { seed: fromB64url(j.seed) }); } catch { throw coded("KEYFILE_BAD", "That key file is damaged."); }
      const old = store.get(seedKey(a));
      if (old && old !== j.seed) store.set(`${seedKey(a)}.prev`, old);
      store.set(seedKey(a), j.seed);
      putKeys(k);
      setStatus(null);
      await refresh();
      return;
    }
    const phrase = (j?.app === "coffer" && typeof j.phrase === "string") ? j.phrase.trim().toLowerCase().split(/\s+/).join(" ") : phraseIn(text);
    if (!phrase) throw coded("KEYFILE_BAD", "That isn't a Coffer key file.");
    try { await work("identity", { phrase }); } catch { throw coded("KEYFILE_BAD", "That key file is damaged."); }
    store.set(PHRASE, phrase);
    setHasBrowserKey(true);
    await takeLocal(phrase);
    store.set(KIND, "local");
    setKind("local");
  }, [kind, connectQorex, refresh, takeLocal]);

  const keyFile = useCallback(() => {
    const a = addrRef.current;
    if (!a) return null;
    const name = `coffer-private-key-${a.slice(0, 12)}.json`;
    if (kind === "local") {
      const phrase = store.get(PHRASE);
      return phrase ? { name, text: JSON.stringify({ warning: WARNING, app: "coffer", version: 1, kind: "browser", address: a, phrase }, null, 2) + "\n" } : null;
    }
    const seed = store.get(seedKey(a));
    return seed ? { name, text: JSON.stringify({ warning: WARNING, app: "coffer", version: 1, kind: "qorex", address: a, seed }, null, 2) + "\n" } : null;
  }, [kind]);

  const disconnect = useCallback(() => {
    setWallet(null);
    store.set(KIND, null);
    setKind(null);
    putAddress(null);
    putKeys(null);
    setId(null);
    setStatus(null);
    setStatusError(null);
    setJustConnected(false);
  }, []);

  const forgetKey = useCallback(() => {
    const a = addrRef.current;
    if (kind === "local") { store.set(PHRASE, null); setHasBrowserKey(false); disconnect(); return; }
    if (a) { store.set(seedKey(a), null); putKeys(null); setStatus(null); void refresh(); }
  }, [kind, disconnect, refresh]);

  const owner = useMemo<OwnerRef | null>(() => (kind === "local" && id ? { kind: "local", id } : kind === "qorex" && address ? { kind: "wallet", address } : null), [kind, id, address]);

  const value = useMemo<Ctx>(() => ({
    kind, address, keys, id, owner, busy, walletMissing, qorexAvailable, hasBrowserKey, error, status, statusError, justConnected,
    connectQorex, chooseBrowser, ensureKeys, newKey, loadKeyFile, keyFile, refresh, disconnect, forgetKey,
  }), [kind, address, keys, id, owner, busy, walletMissing, qorexAvailable, hasBrowserKey, error, status, statusError, justConnected,
    connectQorex, chooseBrowser, ensureKeys, newKey, loadKeyFile, keyFile, refresh, disconnect, forgetKey]);
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

/** The identity when a provider is present (the app), otherwise null (landing, proof). */
export function useIdentityMaybe(): Ctx | null {
  return useContext(IdentityContext);
}

export function useIdentity(): Ctx {
  const c = useContext(IdentityContext);
  if (!c) throw new Error("useIdentity outside IdentityProvider");
  return c;
}

/** Ready: the account's signing key is on chain and its current card names the keys in this browser. */
export const isReady = (s: Status | null) => !!s && s.pq && s.card.state === "ours";
