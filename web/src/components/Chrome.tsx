// Page chrome: header, compact footer, reveal on scroll, copy.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, usePath } from "../lib/router.tsx";
import { useIdentityMaybe } from "../lib/identity.tsx";
import { short } from "../lib/net.ts";
import { Wordmark } from "./Logo.tsx";

export const REPO = "https://github.com/jenzylove/coffer";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* clipboard blocked */ } }}
      aria-label={`${label}: ${text}`}
    >
      {done ? "Copied" : label}
    </button>
  );
}

function HeaderAddress() {
  const ident = useIdentityMaybe();
  if (!ident?.id) return null;
  return (
    <span className="head-addr">
      <span className="mono addr-v" title={ident.id.address}>{short(ident.id.address, 8, 4)}</span>
      <CopyButton text={ident.id.address} label="Copy" />
    </span>
  );
}

export function TopBar() {
  const path = usePath();
  return (
    <header className="topbar">
      <div className="wrap topbar-in">
        <Link to="/" className="brand" aria-label="Coffer home"><Wordmark /></Link>
        <nav className="topnav" aria-label="Main">
          <Link to="/#how">How it works</Link>
          <Link to="/proof" aria-current={path === "/proof" ? "page" : undefined}>Proof</Link>
          <a href={REPO} target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <div className="topbar-right">
          {path === "/app" ? <HeaderAddress /> : <Link to="/app" className="btn-outline">Open the app</Link>}
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-in">
        <Link to="/" className="brand" aria-label="Coffer home"><Wordmark /></Link>
        <nav aria-label="Footer">
          <span><Link to="/app">Open the app</Link><Link to="/#how">How it works</Link><Link to="/#scan">Check your repo</Link></span>
          <span><Link to="/proof">What's real</Link><Link to="/#safety">Safety</Link><Link to="/#faq">Questions</Link></span>
          <span><a href={REPO} target="_blank" rel="noreferrer">GitHub repo</a><a href={`${REPO}#the-cli`} target="_blank" rel="noreferrer">Install the CLI</a></span>
        </nav>
        <p>Testnet only for now. Built for Build Before Q Day.</p>
      </div>
    </footer>
  );
}

/** Fades a block up a little once it scrolls into view. */
export function Reveal({ children, as: As = "div", className = "", id }: { children: ReactNode; as?: any; className?: string; id?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) { setShown(true); return; }
    // also reveal anything already scrolled past, so a fast scroll on a busy page never skips a block
    const io = new IntersectionObserver(([e]) => { if (e && (e.isIntersecting || e.boundingClientRect.top < 0)) { setShown(true); io.disconnect(); } }, { rootMargin: "0px 0px -10% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <As ref={ref} id={id} className={`reveal ${shown ? "in" : ""} ${className}`}>{children}</As>;
}

export function Page({ children }: { children: ReactNode }) {
  return (
    <>
      <TopBar />
      <main id="main">{children}</main>
      <Footer />
    </>
  );
}
