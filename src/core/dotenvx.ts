// Read dotenvx-encrypted env files (ECIES on secp256k1, via eciesjs).
// Browser-safe: no Buffer, no node: imports.

import { decrypt } from "eciesjs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseDotenv } from "./dotenv.ts";
import type { DotenvEntry } from "./dotenv.ts";

export interface DotenvxScan {
  isDotenvx: boolean;
  publicKeyName?: string;
  publicKey?: string;
  environment?: string;
  encryptedKeys: string[];
  plainKeys: string[];
  curve: "secp256k1";
}

export interface DotenvxImport {
  entries: DotenvEntry[];
  publicKey: string;
  environment?: string;
}

const PUBLIC_PREFIX = "DOTENV_PUBLIC_KEY";
const PRIVATE_PREFIX = "DOTENV_PRIVATE_KEY";
const ENC = "encrypted:";

function isPublicKeyName(name: string): boolean {
  return name === PUBLIC_PREFIX || name.startsWith(PUBLIC_PREFIX + "_");
}

function envOf(name: string, prefix: string): string | undefined {
  return name === prefix ? undefined : name.slice(prefix.length + 1).toLowerCase();
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compressed secp256k1 public key (hex) for a private key hex, or undefined if invalid. */
function derivePublic(privateHex: string): string | undefined {
  try {
    return bytesToHex(secp256k1.getPublicKey(hexToBytes(privateHex), true));
  } catch {
    return undefined;
  }
}

export function scanDotenvx(envText: string): DotenvxScan {
  const entries = parseDotenv(envText);
  const scan: DotenvxScan = {
    isDotenvx: false,
    encryptedKeys: [],
    plainKeys: [],
    curve: "secp256k1",
  };
  for (const { key, value } of entries) {
    if (isPublicKeyName(key)) {
      if (scan.publicKeyName === undefined) {
        scan.publicKeyName = key;
        scan.publicKey = value;
        const env = envOf(key, PUBLIC_PREFIX);
        if (env !== undefined) scan.environment = env;
      }
      scan.isDotenvx = true;
    } else if (value.startsWith(ENC)) {
      scan.encryptedKeys.push(key);
      scan.isDotenvx = true;
    } else {
      scan.plainKeys.push(key);
    }
  }
  return scan;
}

export function importDotenvx(envText: string, keysText: string): DotenvxImport {
  const scan = scanDotenvx(envText);
  if (!scan.isDotenvx || scan.publicKey === undefined || scan.publicKeyName === undefined) {
    throw new Error("No DOTENV_PUBLIC_KEY found: this does not look like a dotenvx encrypted file.");
  }
  const publicKey = scan.publicKey.trim().toLowerCase();
  const suffix = scan.publicKeyName.slice(PUBLIC_PREFIX.length); // "" or "_PRODUCTION"
  const wantedName = PRIVATE_PREFIX + suffix;

  const candidates = parseDotenv(keysText).filter(
    (e) => e.key === PRIVATE_PREFIX || e.key.startsWith(PRIVATE_PREFIX + "_"),
  );
  const named = candidates.filter((e) => e.key.toUpperCase() === wantedName.toUpperCase());
  const matches = (v: string) => {
    const pub = derivePublic(v.trim());
    return pub !== undefined && pub === publicKey;
  };
  const found =
    named.find((e) => matches(e.value)) ?? candidates.find((e) => matches(e.value));
  if (!found) {
    throw new Error(
      `No private key in the keys file matches ${scan.publicKeyName} (looked for ${wantedName}). ` +
        `Make sure this is the .env.keys that belongs to this file.`,
    );
  }
  const privateKey = found.value.trim();

  const entries: DotenvEntry[] = [];
  for (const { key, value } of parseDotenv(envText)) {
    if (isPublicKeyName(key)) continue;
    if (!value.startsWith(ENC)) {
      entries.push({ key, value });
      continue;
    }
    try {
      const plain = decrypt(privateKey, base64ToBytes(value.slice(ENC.length)));
      entries.push({ key, value: new TextDecoder("utf-8", { fatal: true }).decode(plain) });
    } catch {
      throw new Error(`Could not decrypt the value of ${key}: the file or its key may be damaged.`);
    }
  }
  const result: DotenvxImport = { entries, publicKey };
  if (scan.environment !== undefined) result.environment = scan.environment;
  return result;
}
