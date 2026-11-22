# Build log

## 17 Nov 2026

**Phase 0, spike (pass).** A fresh account registers its ML-DSA-87 key, then its ML-KEM-1024 key (0.054 QOR once). A second account seals to it knowing only the `qor1` address. `EpochKeyManager` locks a removed reader out of the next epoch. Details and hashes: `docs/spikes/address-seal.md`.

**Phase 1, core.** `.env.coffer` format: the env file sealed under an epoch key; the epoch key sealed with ML-KEM-1024 to every reader; the owner's ML-DSA-87 signature over who can read; the writer's signature over what was written. 37 unit tests, including tamper cases (edited reader list, rolled-back contents, forged writer, a look-alike file sealed by an attacker). dotenvx import is tested against real dotenvx output.

**Phase 2, CLI on testnet (pass).** Three-member team through the real CLI (`init`, `lock`, `share`, `run`, `revoke`, `set`, `status`):

| Step | Result | Tx |
|---|---|---|
| A seals `.env`, records create | ok | `FE210BDF968E360D03D7F952410A4C3029486030F19F3B807C90A3A89B595919` |
| A shares with B and C | both run with the secrets | `AEBA0CF76C741934A6FB4D70C5022007E5A3D4325A06F059D3A762886B6F4060` |
| A revokes C | B runs; C gets "not a reader" | `47DECAD5A58F4EFCA31C28EE12083F2A2F661D423390A446C7A160E36AAFCBAE` |
| Restore the pre-revoke file on a fresh machine | refused: chain record says a later epoch exists | |
| Hand-edit the reader list | refused: owner signature fails | |
| Plain text on disk after all steps | none outside the original `.env` | |

Fixed on the way: file ids are now random and signed (an id derived from owner and name made a recreated file look like a rollback forever).

## 17 to 18 Nov 2026

**Live at https://coffer.jdollar.site.** The full judge path (scan, address setup paid by the relayer, seal, share with the demo teammate, open, revoke, refused, rollback refused, open and verify a file, tampered copy refused) runs in about 80 seconds against testnet.

**Independent audit, fixes proven on testnet.**
- Someone with write access to a repo could replace `.env.coffer` with their own valid file sealed to you. The CLI now remembers each file's owner per path and refuses a copy from a different owner; the testnet run shows a revoked teammate's swapped file refused for both `run` and `set`.
- Shares and revokes are recorded on chain before the file is written; a file newer than its record is refused. History reads are paginated.
- `coffer set KEY` asks for the value so it stays out of shell history.
- Relayer: client address taken from the proxy hop, requests reserved before any lookup, proxy limited to GET and POST.

## 22 Nov 2026

**Why the design changed.** A QoreX user could not be shared with: QoreX refuses `MsgRegisterKEMKey` from websites. QoreX 0.4.3 does sign messages with both keys (`signArbitrary`), so the owner's real wallet signed a QoreSeal recipient card on a test page, and it verified against the wallet's ML-DSA-87 key on chain.

**Coffer contract.** Cards and file heads, every signature checked by the `pqcVerify` (0x0A01) and `pqcKeyStatus` (0x0A02) precompiles, proof of possession required. Texts are byte identical to QoreSeal's card text and to the core's change text (test vectors generated from the TypeScript code). 17 Foundry tests. Deployed `0x598d87f328739a6155486b41e4d191ff9e7f7d24` (tx `0x57f8124d215e7b15659e917eae82192209982e1a8ce430d8197e64b97a890a68`); the poster's EVM window is scoped to it.

**Format 2.** Hybrid sealing (ML-KEM-1024 + X25519), one owner signature per change, the reader list in the signed text, the sealed file carried in each change so it reaches readers through the chain (`filesOf`, `coffer inbox`, `coffer pull`). A file that would pass the contract's 64 KB limit (about 10 people) is refused before anyone signs. 40 unit tests.

**On testnet, two people on the CLI, nothing copied between them:**

| Step | Result | Tx |
|---|---|---|
| Demo teammate's card | recorded after the contract checked it | `0x206b033d100c156f0ce60d5c4de3ae425c832d9da1b235cd04db35945043cbcb` |
| Owner seals a .env to the teammate (epoch 1) | the file is listed under the teammate's address | `0xe79f5978f3dd39c85ada09ecd5a61b2ac5ddde18b463cede6e0875f3a67fca7b` |
| Teammate: `coffer inbox`, `coffer pull`, `coffer run` | their app gets the values | |
| Owner removes the teammate (epoch 2) | their inbox says they were removed; the new version does not open | `0xecce0e1de5e982a1a44bc6a2720ef9eff9d244e04a91b6f38b35cc713307e9c4` |
| The epoch 1 copy sent back to the demo teammate | refused: QoreChain has a newer one | |

**Refusals checked against the live contract:** a forged card (BadSignature), a card from an account whose key has no proof of possession (NoProvenKey), a card older than the current one (StaleCard), an older epoch of a file (StaleEpoch), a change from someone other than the owner (NotOwner).

**Web.** Connect QoreX or use this browser (no recovery phrase shown); share by wallet address; Shared with you read from the chain; invites tied to the invited address; the owner sees "ready, add them" when an invitee signs. The browser journey passed on the live site (16 of 16 and 8 of 8 checks).

**Costs, measured:** a card about 589,500 gas (about 0.06 QOR); a change with one reader 759,521 to 1,126,453 gas (0.08 to 0.11 QOR) at 101 gwei, paid by the Coffer server.
