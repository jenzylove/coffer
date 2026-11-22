// The landing hero's worker: only what the live demo needs (sealing to Ada and
// Sam, opening, refusing), so the landing never downloads the chain code.
import { seal, open, toBase64Url, isQoreSealError } from "@qorechain/qoreseal";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { identityFromMnemonic, newMnemonic } from "../../../src/core/identity.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const HERO = { chainId: "qorechain-diana", purpose: "coffer:hero" };
// Ada stays a reader, Sam is removed: two real throwaway identities per visit
let hero: { reader: SealKeyPair; removed: SealKeyPair; ada: string; sam: string; plain: Uint8Array; env?: Uint8Array } | null = null;
const chunks = (env: Uint8Array) => { const b = toBase64Url(env.slice(-60)); return [b.slice(0, 18), b.slice(18, 36), b.slice(36, 54)]; };

const ops: Record<string, (a: any) => unknown> = {
  heroInit({ lines }: { lines: string[] }) {
    if (!hero) {
      const ada = identityFromMnemonic(newMnemonic()), sam = identityFromMnemonic(newMnemonic());
      hero = { reader: ada.sealKeys, removed: sam.sealKeys, ada: ada.address, sam: sam.address, plain: enc.encode(lines.join("\n")) };
    }
    return { ada: hero.ada, sam: hero.sam };
  },
  heroSeal({ both }: { both: boolean }) {
    const h = hero!;
    const recipients = [{ mlkemPublicKey: h.reader.mlkemPublicKey }, ...(both ? [{ mlkemPublicKey: h.removed.mlkemPublicKey }] : [])];
    h.env = seal({ ...HERO, mode: "mlkem", plaintext: h.plain, recipients });
    return { cipher: chunks(h.env), bytes: h.env.length };
  },
  /** What Ada reads: the real decrypted lines, NAME=value. */
  heroOpen() {
    return dec.decode(open({ ...HERO, envelope: hero!.env!, keys: hero!.reader })).split("\n").filter(Boolean);
  },
  /** "refused" only when the real open throws NOT_A_RECIPIENT. */
  heroRefuse() {
    try { open({ ...HERO, envelope: hero!.env!, keys: hero!.removed }); return "opened"; }
    catch (e) { return isQoreSealError(e, "NOT_A_RECIPIENT") ? "refused" : "error"; }
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
