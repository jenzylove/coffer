import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { IdentityProvider } from "./lib/identity.tsx";
import { usePath } from "./lib/router.tsx";
import { Landing } from "./landing/Landing.tsx";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IdentityProvider>
      <Root />
    </IdentityProvider>
  </StrictMode>,
);
