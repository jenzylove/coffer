// Page chrome: top bar (with identity status on every page), footer, theme, reveal, copy.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, usePath } from "../lib/router.tsx";
import { useIdentity, isReady } from "../lib/identity.tsx";
import { short } from "../lib/net.ts";
import { Wordmark } from "./Logo.tsx";

type Theme = "light" | "dark";
function initialTheme(): Theme {
  try {
    const t = localStorage.getItem("coffer.theme");
    if (t === "light" || t === "dark") return t;
  } catch { /* storage blocked */ }
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.dispatchEvent(new Event("coffer-theme"));
  }, [theme]);
  return [theme, () => setTheme((t) => {
    const n = t === "dark" ? "light" : "dark";
    try { localStorage.setItem("coffer.theme", n); } catch { /* storage blocked */ }
    return n;
  })];
}

function ThemeToggle() {
  const [theme, toggle] = useTheme();
  return (
    <button className="iconbtn" onClick={toggle} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title="Theme">
      {theme === "dark" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
      )}
    </button>
  );
}

export function IdentityChip() {
  const { id, phrase, deriving, status, statusError } = useIdentity();
  let dot = "idle", label = "No address";
  if (phrase && (deriving || !id)) { dot = "busy"; label = "Loading your keys"; }
  else if (id && statusError) { dot = "warn"; label = short(id.address, 8, 4); }
  else if (id && !status) { dot = "busy"; label = short(id.address, 8, 4); }
  else if (id && isReady(status)) { dot = "open"; label = short(id.address, 8, 4); }
  else if (id) { dot = "warn"; label = short(id.address, 8, 4); }
  const title = !id ? "Create an address in the app" : statusError ? `Could not reach QoreChain: ${statusError}` : isReady(status) ? "Ready: files can be sealed to this address" : "Not set up on QoreChain yet";
  return (
    <Link to="/app" className="idchip" title={title}>
      <span className={`dot dot-${dot}`} aria-hidden />
      <span className="idchip-label">{label}</span>
      <span className="sr">{title}</span>
    </Link>
  );
}

export function TopBar() {
  const path = usePath();
  return (
    <header className="topbar">
      <div className="topbar-in">
        <Link to="/" className="brand" aria-label="Coffer home"><Wordmark /></Link>
        <nav className="navpill" aria-label="Main">
          <Link to="/#how" className="hide-sm">How it works</Link>
          <Link to="/proof" aria-current={path === "/proof" ? "page" : undefined}>Proof</Link>
          <Link to="/app" aria-current={path === "/app" ? "page" : undefined}>App</Link>
        </nav>
        <div className="topbar-right">
          <ThemeToggle />
          <IdentityChip />
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-in">
        <div className="footer-brand">
          <Wordmark />
          <p className="muted small">Your .env, sealed to your team. Testnet only for now.</p>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <Link to="/app">App</Link>
          <Link to="/app#open">Open a file</Link>
          <Link to="/#scan">Scan a repo</Link>
          <Link to="/proof">Proof</Link>
          <Link to="/#safety">Safety</Link>
          <Link to="/#faq">Questions</Link>
          <a href="https://github.com/jenzylove/coffer" target="_blank" rel="noreferrer">GitHub repo</a>
          <a href="https://github.com/jenzylove/coffer#the-cli" target="_blank" rel="noreferrer">Install the CLI</a>
        </nav>
      </div>
      <div className="wrap">
        <div className="footer-base">
          <span>Built for Build Before Q Day, the QoreChain developer fest.</span>
          <span>Apache 2.0</span>
        </div>
      </div>
    </footer>
  );
}

/** Fades a block in once it scrolls into view. */
export function Reveal({ children, as: As = "div", className = "", delay = 0, id }: { children: ReactNode; as?: any; className?: string; delay?: number; id?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) { setShown(true); return; }
    // also reveal anything already scrolled past, so a fast scroll on a busy page never skips a block
    const io = new IntersectionObserver(([e]) => { if (e && (e.isIntersecting || e.boundingClientRect.top < 0)) { setShown(true); io.disconnect(); } }, { rootMargin: "0px 0px -12% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <As ref={ref} id={id} className={`reveal ${shown ? "in" : ""} ${className}`} style={{ transitionDelay: `${delay}ms` }}>{children}</As>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copybtn"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* clipboard blocked */ }
      }}
      aria-label={`${label}: ${text}`}
    >
      {done ? "Copied" : label}
    </button>
  );
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
