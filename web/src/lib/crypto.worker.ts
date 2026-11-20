// All heavy crypto runs here, off the main thread: ML-KEM key generation,
// sealing and opening, ML-DSA signing and checking, and recovery phrase
// derivation. Same functions the CLI uses (src/core); nothing reimplemented.
import { generateSealKeys, seal, open, toBase64Url, isQoreSealError } from "@qorechain/qoreseal";
import type { SealKeyPair } from "@qorechain/qoreseal";
import {
  createCoffer, shareCoffer, revokeCoffer, openCoffer, verifyCoffer, formatCoffer, parseCoffer,
  type Reader,
} from "../../../src/core/vault.ts";
import { identityFromMnemonic, newMnemonic, type Identity } from "../../../src/core/identity.ts";
import { parseDotenv, serializeDotenv } from "../../../src/core/dotenv.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const CHAIN = "qorechain-diana";

// ---- hero: keys made once per page view, a fresh seal every loop -------------
const HERO = { chainId: CHAIN, purpose: "coffer:hero" };
let hero: { reader: SealKeyPair; removed: SealKeyPair; plain: Uint8Array; env?: Uint8Array } | null = null;
const chunks = (env: Uint8Array) => { const b = toBase64Url(env.slice(-60)); return [b.slice(0, 18), b.slice(18, 36), b.slice(36, 54)]; };

// ---- landing demo: three throwaway identities ----------------------------------
type Who = "you" | "one" | "two";
let demo: { ids: Record<Who, Identity>; file?: ReturnType<typeof createCoffer> } | null = null;
function canOpen(f: ReturnType<typeof createCoffer>) {
  const out: Partial<Record<Who, "open" | "refused">> = {};
  for (const w of ["you", "one", "two"] as Who[]) {
    try { openCoffer(f, demo!.ids[w].sealKeys); out[w] = "open"; }
    catch (e) { if ((e as { code?: string }).code === "NOT_A_READER") out[w] = "refused"; else throw e; }
  }
  return out;
}
const namesOf = (p: Uint8Array) => parseDotenv(dec.decode(p)).map((e) => e.key);

const ops: Record<string, (a: any) => unknown> = {
  /** The GPU's name, checked here so creating a probe context never blocks the page. */
  gpu() {
    try {
      const gl = new OffscreenCanvas(1, 1).getContext("webgl2") as WebGL2RenderingContext | null;
      if (!gl) return null;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return name;
    } catch { return null; }
  },
  heroInit({ lines }: { lines: string[] }) {
    if (!hero) hero = { reader: generateSealKeys(), removed: generateSealKeys(), plain: enc.encode(lines.join("\n")) };
    return true;
  },
  heroSeal({ both }: { both: boolean }) {
    const h = hero!;
    const recipients = [{ mlkemPublicKey: h.reader.mlkemPublicKey }, ...(both ? [{ mlkemPublicKey: h.removed.mlkemPublicKey }] : [])];
    h.env = seal({ ...HERO, mode: "mlkem", plaintext: h.plain, recipients });
    return { cipher: chunks(h.env), bytes: h.env.length };
  },
  heroOpen() {
    return dec.decode(open({ ...HERO, envelope: hero!.env!, keys: hero!.reader })).split("\n").map((l) => l.split("=")[0] ?? "");
  },
  /** "refused" only when the real open throws NOT_A_RECIPIENT. */
  heroRefuse() {
    try { open({ ...HERO, envelope: hero!.env!, keys: hero!.removed }); return "opened"; }
    catch (e) { return isQoreSealError(e, "NOT_A_RECIPIENT") ? "refused" : "error"; }
  },

  demoSeal({ env }: { env: string }) {
    if (!demo) { const make = () => identityFromMnemonic(newMnemonic()); demo = { ids: { you: make(), one: make(), two: make() } }; }
    const entries = parseDotenv(env);
    if (!entries.length) throw new Error("Write at least one line like NAME=value first.");
    const ids = demo.ids;
    demo.file = createCoffer({ chainId: CHAIN, name: ".env", owner: ids.you, ownerMlkem: ids.you.sealKeys.mlkemPublicKey, plaintext: enc.encode(serializeDotenv(entries)) });
    return { can: canOpen(demo.file), count: entries.length, text: formatCoffer(demo.file) };
  },
  demoShare() {
    const ids = demo!.ids;
    demo!.file = shareCoffer(demo!.file!, ids.you, ids.you.sealKeys, [ids.one, ids.two].map((i) => ({ address: i.address, mlkemPublicKey: i.sealKeys.mlkemPublicKey })));
    return { can: canOpen(demo!.file), text: formatCoffer(demo!.file) };
  },
  demoRevoke() {
    const ids = demo!.ids;
    const { file, rotate } = revokeCoffer(demo!.file!, ids.you, ids.you.sealKeys, [ids.two.address], namesOf);
    demo!.file = file;
    return { can: canOpen(file), rotate, text: formatCoffer(file) };
  },
  demoRun() {
    const ids = demo!.ids, f = demo!.file!;
    const pq = Object.fromEntries((["you", "one", "two"] as Who[]).map((w) => [ids[w].address, ids[w].pqKey.publicKey]));
    verifyCoffer(f, pq);
    const names = namesOf(openCoffer(f, ids.one.sealKeys));
    let tamperRefused = false;
    try { verifyCoffer({ ...f, readers: [...f.readers, ids.two.address] }, pq); } catch { tamperRefused = true; }
    return { names, tamperRefused };
  },

  // ---- the app ----
  newPhrase: () => newMnemonic(),
  identity: ({ phrase }: { phrase: string }) => identityFromMnemonic(phrase),
  create({ name, owner, env }: { name: string; owner: Identity; env: string }) {
    const f = createCoffer({ chainId: CHAIN, name, owner, ownerMlkem: owner.sealKeys.mlkemPublicKey, plaintext: enc.encode(serializeDotenv(parseDotenv(env))) });
    return formatCoffer(f);
  },
  share({ text, owner, readers }: { text: string; owner: Identity; readers: Reader[] }) {
    return formatCoffer(shareCoffer(parseCoffer(text), owner, owner.sealKeys, readers));
  },
  revoke({ text, owner, addresses }: { text: string; owner: Identity; addresses: string[] }) {
    const { file, rotate } = revokeCoffer(parseCoffer(text), owner, owner.sealKeys, addresses, namesOf);
    return { text: formatCoffer(file), rotate };
  },
  verify({ text, pqKeys }: { text: string; pqKeys: Record<string, Uint8Array> }) {
    verifyCoffer(parseCoffer(text), pqKeys);
    return true;
  },
  open({ text, keys }: { text: string; keys: SealKeyPair }) {
    return parseDotenv(dec.decode(openCoffer(parseCoffer(text), keys)));
  },
};

self.onmessage = async (e: MessageEvent<{ id: number; op: string; args: unknown }>) => {
  const { id, op, args } = e.data;
  try {
    const fn = ops[op];
    if (!fn) throw new Error(`unknown operation ${op}`);
    (self as unknown as Worker).postMessage({ id, ok: true, value: await fn(args) });
  } catch (err) {
    const x = err as { message?: string; code?: string };
    (self as unknown as Worker).postMessage({ id, ok: false, message: x?.message ?? String(err), code: x?.code });
  }
};
