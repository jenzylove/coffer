import { StrictMode, Suspense, lazy, startTransition, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { usePath } from "./lib/router.tsx";
import { Landing } from "./landing/Landing.tsx";
import "@fontsource-variable/mona-sans/index.css";
import "@fontsource/fragment-mono/latin-400.css";
import "./styles.css";

const AppRoute = lazy(() => import("./app/AppPage.tsx"));
const Proof = lazy(() => import("./proof/Proof.tsx"));

const TITLES: Record<string, string> = {
  "/": "Coffer · Lock your .env to your team",
  "/app": "Coffer · Your files",
  "/proof": "Coffer · What's real",
};

function Root() {
  const path = usePath().replace(/\/+$/, "") || "/";
  useEffect(() => { document.title = TITLES[path] ?? "Coffer"; }, [path]);
  return (
    <Suspense fallback={<div className="loading" aria-busy="true" />}>
      {path === "/app" ? <AppRoute /> : path === "/proof" ? <Proof /> : <Landing />}
    </Suspense>
  );
}

// a transition lets React split the first render into small slices instead of one long task
const root = createRoot(document.getElementById("root")!);
startTransition(() => {
  root.render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
});
