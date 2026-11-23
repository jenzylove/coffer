// Where Coffer lives on the QoreChain testnet. Written after each deploy
// (contracts/script/deploy.ts); the full record is deployments/testnet.json.
import type { Hex } from "viem";

export const EVM_TESTNET = "https://evm-testnet.qore.host";
export const COFFER_CONTRACT: Hex = "0x1ee9f98e8784f150d54a7ceea97026d4320746db";
/** The keeper the Coffer server runs: release pieces are sealed to its card. */
export const COFFER_KEEPER = "qor1kgdvm6gngc5a2esk5kuask7zjswcyp8rjrpp0u";
export const COFFER_SERVER = "https://coffer.jdollar.site";
