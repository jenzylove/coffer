// The repo check: paste a public repo, see its env files as document rows, move one to Coffer.
import { useState, type FormEvent } from "react";
import { api } from "../lib/net.ts";
import { navigate } from "../lib/router.tsx";
import { Stamp, Tag } from "../components/Doc.tsx";

export interface ScanFile {
  path: string;
  kind: "dotenvx" | "plain" | "coffer" | "example";
  publicKey?: string;
  encrypted: number;
  plain: number;
  keys: string[];
}
export interface ScanResult { repo: string; branch: string; files: ScanFile[]; truncated: boolean }

/** What the app's import step needs to pick up a scanned file. */
export interface ImportHint { repo: string; branch: string; path: string; kind: ScanFile["kind"]; keys: string[] }
export const IMPORT_KEY = "coffer.import";

const values = (n: number) => `${n} ${n === 1 ? "value" : "values"}`;

export function ScanDoor() {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<ScanResult | null>(null);
  const [all, setAll] = useState(false);

  async function scan(e: FormEvent) {
    e.preventDefault();
    const q = repo.trim();
    if (!q) { setErr("Paste a repo like owner/name or its GitHub link."); return; }
    setBusy(true); setErr(null); setRes(null); setAll(false);
    try { setRes(await api<ScanResult>(`/api/scan?repo=${encodeURIComponent(q)}`)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  function move(f: ScanFile) {
    if (!res) return;
    const hint: ImportHint = { repo: res.repo, branch: res.branch, path: f.path, kind: f.kind, keys: f.keys };
    try { sessionStorage.setItem(IMPORT_KEY, JSON.stringify(hint)); } catch { /* storage blocked */ }
    navigate("/app#seal");
  }

  const risky = res?.files.filter((f) => f.kind === "dotenvx" || f.kind === "plain") ?? [];
  const rest = res?.files.filter((f) => f.kind === "coffer" || f.kind === "example") ?? [];
  const shown = [...(all ? risky : risky.slice(0, 5)), ...(all || risky.length <= 5 ? rest : [])];

  return (
    <div className="door">
      <form onSubmit={scan} className="door-form" role="search">
        <label htmlFor="repo" className="sr">A public GitHub repo</label>
        <input id="repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name or a github.com link" autoComplete="off" spellCheck={false} inputMode="url" />
        <button className="btn" disabled={busy}>{busy ? "Scanning" : "Scan"}</button>
      </form>
      <p className="note">No wallet, no sign up. We read the default branch and show key names only.</p>

      {err && <p className="problem-line" role="alert">{err}</p>}

      {res && (
        <div className="door-out" aria-live="polite">
          <p className="door-sum">
            <span className="mono">{res.repo}</span>: {risky.length ? `${risky.length} ${risky.length === 1 ? "file" : "files"} at risk.` : res.files.length ? "nothing at risk." : "no env files found."}
            {res.truncated && " GitHub stopped listing early, so some files may be missing."}
          </p>
          <ul className="hits">
            {shown.map((f) => (
              <li key={f.path}>
                <div className="hit-main">
                  <span className="mono hit-path">{f.path}</span>
                  {f.keys.length > 0 && <span className="mono hit-keys">{f.keys.slice(0, 6).join("  ")}{f.keys.length > 6 ? `  +${f.keys.length - 6}` : ""}</span>}
                  <span className="hit-text">
                    {f.kind === "plain" && `Plain text: anyone can read ${values(f.plain || f.keys.length)} now.`}
                    {f.kind === "dotenvx" && `${values(f.encrypted)} locked with a curve a quantum computer breaks.`}
                    {f.kind === "coffer" && "Already sealed by Coffer."}
                    {f.kind === "example" && "A template with names only. Nothing to protect."}
                  </span>
                </div>
                <div className="hit-side">
                  {f.kind === "plain" && <Stamp tone="red">Exposed</Stamp>}
                  {f.kind === "dotenvx" && <Tag>secp256k1</Tag>}
                  {f.kind === "coffer" && <Stamp>Sealed</Stamp>}
                  {(f.kind === "plain" || f.kind === "dotenvx") && <button className="link" onClick={() => move(f)}>Move it to Coffer</button>}
                </div>
              </li>
            ))}
          </ul>
          {!all && risky.length > 5 && <button className="link" onClick={() => setAll(true)}>Show all {risky.length}</button>}
        </div>
      )}
    </div>
  );
}
