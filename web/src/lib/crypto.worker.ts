// All heavy crypto runs here, off the main thread: ML-KEM key generation,
// sealing and opening, ML-DSA signing and checking, and recovery phrase
// derivation. Same functions the CLI uses (src/core); nothing reimplemented.
import type { SealKeyPair } from "@qorechain/qoreseal";
import {
  createCoffer, shareCoffer, revokeCoffer, openCoffer, verifyCoffer, formatCoffer, parseCoffer,
  type Reader,
} from "../../../src/core/vault.ts";
import { identityFromMnemonic, newMnemonic, type Identity } from "../../../src/core/identity.ts";
import { parseDotenv, serializeDotenv } from "../../../src/core/dotenv.ts";
import { accountStatus, fetchReader, fetchPqKeys, grantHistory, registerIdentity, recordGrant, type Grant, type Network } from "../../../src/chain/qore.ts";

// QoreChain goes through our own server (/rest); relative URLs resolve to this origin in the worker too
const NET: Network = { chainId: "qorechain-diana", rest: "/rest" };

const enc = new TextEncoder();
const dec = new TextDecoder();
const CHAIN = "qorechain-diana";

// ---- landing story: three throwaway identities (you, Ada, Sam) -----------------
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

type Progress = (text: string, hash?: string) => void;
const ops: Record<string, (a: any, progress: Progress) => unknown> = {
  // ---- QoreChain: reads, setup and records, all off the main thread ----
  accountStatus: ({ address, mlkem }: { address: string; mlkem?: Uint8Array }) => accountStatus(NET, address, mlkem),
  fetchReader: ({ address }: { address: string }) => fetchReader(NET, address),
  fetchPqKeys: ({ addresses }: { addresses: string[] }) => fetchPqKeys(NET, addresses),
  grantHistory: ({ owner, id }: { owner: string; id?: string }) => grantHistory(NET, owner, id),
  registerIdentity: ({ id }: { id: Identity }, progress) => registerIdentity(NET, id, (s, tx) => progress(s, tx?.hash)),
  recordGrant: ({ owner, grant }: { owner: Identity; grant: Grant }) => recordGrant(NET, owner, grant),

  /** The story's people: you (owner), Ada and Sam. Real throwaway identities. */
  demoInit() {
    if (!demo) { const make = () => identityFromMnemonic(newMnemonic()); demo = { ids: { you: make(), one: make(), two: make() } }; }
    return { you: demo.ids.you.address, ada: demo.ids.one.address, sam: demo.ids.two.address };
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
    // what Ada reads once she is a reader: the real decrypted lines
    const ada = dec.decode(openCoffer(demo!.file, ids.one.sealKeys)).split("\n").filter(Boolean);
    return { can: canOpen(demo!.file), text: formatCoffer(demo!.file), ada };
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
    const progress: Progress = (text, hash) => (self as unknown as Worker).postMessage({ id, progress: { text, hash } });
    (self as unknown as Worker).postMessage({ id, ok: true, value: await fn(args, progress) });
  } catch (err) {
    const x = err as { message?: string; code?: string };
    (self as unknown as Worker).postMessage({ id, ok: false, message: x?.message ?? String(err), code: x?.code });
  }
};
