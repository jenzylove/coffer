// The front door: paste a public repo, see its env files in plain words, move one to Coffer.
import { useState, type FormEvent } from "react";
import { api } from "../lib/net.ts";
import { navigate } from "../lib/router.tsx";

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

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function sentence(f: ScanFile): { tone: "seal" | "hot" | "open" | "dim"; text: string } {
  if (f.kind === "dotenvx") return { tone: "seal", text: `${plural(f.encrypted, "value")} locked with secp256k1: a quantum computer can open these later.${f.plain ? ` ${plural(f.plain, "more value")} sit in plain text.` : ""}` };
  if (f.kind === "plain") return { tone: "hot", text: `This file is in plain text: anyone can read its ${plural(f.plain || f.keys.length, "value")} now. Rotate them, then seal the new ones.` };
  if (f.kind === "coffer") return { tone: "open", text: "Already sealed by Coffer." };
  return { tone: "dim", text: "A template with names only. Nothing to protect here." };
}

export function ScanDoor({ compact = false }: { compact?: boolean }) {
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
    try {
      setRes(await api<ScanResult>(`/api/scan?repo=${encodeURIComponent(q)}`));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function move(f: ScanFile) {
    if (!res) return;
    const hint: ImportHint = { repo: res.repo, branch: res.branch, path: f.path, kind: f.kind, keys: f.keys };
    try { sessionStorage.setItem(IMPORT_KEY, JSON.stringify(hint)); } catch { /* storage blocked */ }
    navigate("/app#seal");
  }

  const risky = res?.files.filter((f) => f.kind === "dotenvx" || f.kind === "plain") ?? [];
  const rest = res?.files.filter((f) => f.kind === "coffer" || f.kind === "example") ?? [];

  return (
    <div className={`door ${compact ? "door-compact" : ""}`} id={compact ? undefined : "scan"}>
      <form onSubmit={scan} className="door-form" role="search">
        <label htmlFor={compact ? "repo2" : "repo"} className="door-label">Paste a public GitHub repo</label>
        <div className="door-row">
          <input
            id={compact ? "repo2" : "repo"} value={repo} onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/name or github.com link" autoComplete="off" spellCheck={false} inputMode="url"
          />
          <button className="btn btn-seal" disabled={busy}>{busy ? "Scanning" : "Scan"}</button>
        </div>
        <p className="door-note">No wallet, no sign up. We read the repo's default branch and show key names only.</p>
      </form>

      {err && <p className="msg msg-err" role="alert">{err}</p>}

      {res && (
        <div className="door-out" aria-live="polite">
          <p className="door-sum">
            <span className="mono">{res.repo}</span> on <span className="mono">{res.branch}</span>:{" "}
            {risky.length ? `${plural(risky.length, "env file")} at risk.` : res.files.length ? "nothing at risk." : "no env files found."}
            {res.truncated && " GitHub stopped listing early, so some files may be missing."}
          </p>
          {(all ? risky : risky.slice(0, 5)).map((f) => {
            const s = sentence(f);
            return (
              <div key={f.path} className={`hit hit-${s.tone}`}>
                <div className="hit-main">
                  <span className="mono hit-path">{f.path}</span>
                  <span className="hit-text">{s.text}</span>
                  {f.keys.length > 0 && <span className="hit-keys mono">{f.keys.slice(0, 6).join("  ")}{f.keys.length > 6 ? `  +${f.keys.length - 6}` : ""}</span>}
                </div>
                <button className="btn btn-line" onClick={() => move(f)}>Move it to Coffer</button>
              </div>
            );
          })}
          {!all && risky.length > 5 && <button className="btn btn-quiet btn-sm" onClick={() => setAll(true)}>Show all {risky.length} files at risk</button>}
          {(all || risky.length <= 5) && rest.map((f) => {
            const s = sentence(f);
            return (
              <div key={f.path} className={`hit hit-${s.tone}`}>
                <div className="hit-main"><span className="mono hit-path">{f.path}</span><span className="hit-text">{s.text}</span></div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
