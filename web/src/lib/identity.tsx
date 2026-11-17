// The browser identity: a 24 word recovery phrase kept in localStorage
// (`coffer.identity`), the keys derived from it, and its live status on chain.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Identity } from "../../../src/core/identity.ts";
import type { AccountStatus } from "../../../src/chain/qore.ts";
import { net, errText } from "./net.ts";

const KEY = "coffer.identity";

function readPhrase(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
function writePhrase(p: string | null) {
  try { if (p) localStorage.setItem(KEY, p); else localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

interface Ctx {
  phrase: string | null;
  id: Identity | null;
  deriving: boolean;
  status: AccountStatus | null;
  statusError: string | null;
  checking: boolean;
  /** Make a new identity. Returns the phrase so the caller can show it once. */
  create: () => Promise<string>;
  /** Use an existing phrase. Throws if it is not a valid 24 word phrase. */
  restore: (phrase: string) => Promise<void>;
  forget: () => void;
  refresh: () => Promise<AccountStatus | null>;
}

const IdentityContext = createContext<Ctx | null>(null);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [phrase, setPhrase] = useState<string | null>(() => readPhrase());
  const [id, setId] = useState<Identity | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    setId(null);
    setStatus(null);
    if (!phrase) return;
    setDeriving(true);
    (async () => {
      const { identityFromMnemonic } = await import("../../../src/core/identity.ts");
      // let the browser paint before the key derivation
      await new Promise((ok) => setTimeout(ok, 30));
      try {
        const next = identityFromMnemonic(phrase);
        if (live) setId(next);
      } catch {
        if (live) { writePhrase(null); setPhrase(null); }
      } finally {
        if (live) setDeriving(false);
      }
    })();
    return () => { live = false; };
  }, [phrase]);

  const refresh = useCallback(async () => {
    if (!id) return null;
    setChecking(true);
    try {
      const { accountStatus } = await import("../../../src/chain/qore.ts");
      const st = await accountStatus(net, id.address, id.sealKeys.mlkemPublicKey);
      setStatus(st);
      setStatusError(null);
      return st;
    } catch (e) {
      setStatusError(errText(e));
      return null;
    } finally {
      setChecking(false);
    }
  }, [id]);

  useEffect(() => { if (id) void refresh(); }, [id, refresh]);

  const create = useCallback(async () => {
    const { newMnemonic } = await import("../../../src/core/identity.ts");
    const m = newMnemonic();
    writePhrase(m);
    setPhrase(m);
    return m;
  }, []);

  const restore = useCallback(async (p: string) => {
    const { identityFromMnemonic } = await import("../../../src/core/identity.ts");
    const clean = p.trim().toLowerCase().split(/\s+/).join(" ");
    identityFromMnemonic(clean); // throws on a bad phrase
    writePhrase(clean);
    setPhrase(clean);
  }, []);

  const forget = useCallback(() => { writePhrase(null); setPhrase(null); }, []);

  const value = useMemo<Ctx>(() => ({ phrase, id, deriving, status, statusError, checking, create, restore, forget, refresh }),
    [phrase, id, deriving, status, statusError, checking, create, restore, forget, refresh]);
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): Ctx {
  const c = useContext(IdentityContext);
  if (!c) throw new Error("useIdentity outside IdentityProvider");
  return c;
}

export const isReady = (s: AccountStatus | null) => !!s && s.mldsa && s.kemIsOurs;
