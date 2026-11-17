// One BIP-39 mnemonic gives every key a Coffer identity needs: the secp256k1
// account key (address), its ML-DSA-87 key (signatures), and the QoreSeal
// ML-KEM-1024 + X25519 seal keys (opening files). Pure.
import { addressFromPublicKey, deriveCanonicalPqKey, deriveClassicalKey } from "@qorechain/qoresign";
import type { PqKeyPair } from "@qorechain/qoresign";
import { deriveSealKeys } from "@qorechain/qoreseal";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { Signer } from "./vault.ts";

export interface Identity extends Signer {
  pqKey: PqKeyPair;
  sealKeys: SealKeyPair;
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

export function identityFromMnemonic(mnemonic: string): Identity {
  const m = mnemonic.trim().split(/\s+/).join(" ");
  if (!validateMnemonic(m, wordlist)) throw new Error("not a valid 24 word recovery phrase");
  const classicalKey = deriveClassicalKey({ mnemonic: m });
  const address = addressFromPublicKey(classicalKey.publicKey, "secp256k1").bech32;
  return { address, classicalKey, pqKey: deriveCanonicalPqKey({ mnemonic: m, address }), sealKeys: deriveSealKeys({ mnemonic: m }) };
}
