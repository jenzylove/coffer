// Recipient cards (QoreSeal recipient card v1): an account's signed statement
// "seal to these keys". Any QoreSign signer can sign one: a local identity, or
// a QoreX wallet through signArbitrary. Pure.
import {
  assembleRecipientCard, recipientCardFields, recipientCardText, verifyRecipientCard,
} from "@qorechain/qoreseal";
import type { RecipientCard, SealKeyPair } from "@qorechain/qoreseal";
import type { Reader, Signer } from "./vault.ts";

export type { RecipientCard };

/** Sign a card for `keys` with `signer` (one wallet approval). */
export async function signCard(chainId: string, signer: Signer, keys: Pick<SealKeyPair, "mlkemPublicKey" | "x25519PublicKey">, issuedAt?: Date): Promise<RecipientCard> {
  const fields = recipientCardFields({ chainId, address: signer.address, keys, issuedAt });
  const sig = await signer.sign(chainId, new TextEncoder().encode(recipientCardText(fields)));
  // A wallet may add its own extra fields; keep the QoreSign ones only.
  return assembleRecipientCard(fields, { signatureType: sig.signatureType, classical: sig.classical, ...(sig.pq ? { pq: sig.pq } : {}) });
}

/**
 * Check a card against the account's ML-DSA-87 key on chain and the ML-KEM key
 * it names, and return the reader to seal to. Throws QoreSealError CARD_INVALID.
 */
export function readerFromCard(args: { card: RecipientCard; chainId: string; address: string; pqPublicKey: Uint8Array; mlkemPublicKey: Uint8Array }): Reader {
  const r = verifyRecipientCard({ card: args.card, chainId: args.chainId, address: args.address, pqPublicKey: args.pqPublicKey, mlkemPublicKey: args.mlkemPublicKey });
  return { address: args.address, mlkemPublicKey: r.mlkemPublicKey, x25519PublicKey: r.x25519PublicKey! };
}
