import { Suspense, lazy, startTransition, useEffect, useState } from "react";
import { Page } from "../components/Chrome.tsx";
import { Hero } from "./Hero.tsx";
import { ScanDoor } from "./ScanDoor.tsx";

const Rest = lazy(() => import("./LandingRest.tsx"));

export function Landing() {
  // the sections below the fold load once the browser is idle (at once if a link points into them)
  const [rest, setRest] = useState(() => !!location.hash);
  useEffect(() => {
    if (rest) return;
    const go = () => startTransition(() => setRest(true));
    const w = window as any;
    // cancel only the kind of handle we made: clearTimeout on an idle id can kill an unrelated timer (it froze the hero)
    const idle = !!w.requestIdleCallback;
    const h = idle ? w.requestIdleCallback(go, { timeout: 2500 }) : setTimeout(go, 1200);
    const onScroll = () => go();
    addEventListener("scroll", onScroll, { once: true, passive: true });
    addEventListener("hashchange", go);
    return () => { if (idle) w.cancelIdleCallback(h); else clearTimeout(h); removeEventListener("scroll", onScroll); removeEventListener("hashchange", go); };
  }, [rest]);
  return (
    <Page>
      <Hero />
      <section className="doorbar" aria-label="Scan a repo"><div className="wrap"><ScanDoor /></div></section>
      {rest ? <Suspense fallback={<div className="rest-hold" />}><Rest /></Suspense> : <div className="rest-hold" />}
    </Page>
  );
}
