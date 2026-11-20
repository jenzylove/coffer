import { StrictMode, Suspense, lazy, startTransition, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { IdentityProvider } from "./lib/identity.tsx";
import { usePath } from "./lib/router.tsx";
import { Landing } from "./landing/Landing.tsx";
import "@fontsource-variable/onest/index.css";
import "@fontsource/dm-mono/latin-400.css";
import "@fontsource/dm-mono/latin-500.css";
import "./styles.css";

const AppPage = lazy(() => import("./app/AppPage.tsx"));
const Proof = lazy(() => import("./proof/Proof.tsx"));

const TITLES: Record<string, string> = {
  "/": "Coffer · Push your secrets to GitHub. Only your team can open them.",
  "/app": "Coffer · App",
  "/proof": "Coffer · Proof",
};

function Root() {
  const path = usePath().replace(/\/+$/, "") || "/";
  useEffect(() => { document.title = TITLES[path] ?? "Coffer"; }, [path]);
  return (
    <Suspense fallback={<div className="loading" aria-busy="true" />}>
      {path === "/app" ? <AppPage /> : path === "/proof" ? <Proof /> : <Landing />}
    </Suspense>
  );
}

// a transition lets React split the first render into small slices instead of one long task
const root = createRoot(document.getElementById("root")!);
startTransition(() => {
  root.render(
    <StrictMode>
      <IdentityProvider>
        <Root />
      </IdentityProvider>
    </StrictMode>,
  );
});
