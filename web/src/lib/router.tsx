// A tiny history router: three routes do not need a library.
import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

/** Scroll to an id, waiting briefly for sections that load late. */
export function scrollToId(id: string, tries = 40) {
  const el = document.getElementById(id);
  if (el) { el.scrollIntoView({ behavior: "smooth" }); return; }
  if (tries > 0) setTimeout(() => scrollToId(id, tries - 1), 80);
}

export function navigate(to: string) {
  if (to === location.pathname + location.hash) return;
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  const hash = to.split("#")[1];
  if (hash) scrollToId(hash);
  else window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        const [p, h] = to.split("#");
        if (p === "" || p === location.pathname) {
          if (h) { e.preventDefault(); history.replaceState(null, "", to); window.dispatchEvent(new HashChangeEvent("hashchange")); scrollToId(h); }
          return;
        }
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
