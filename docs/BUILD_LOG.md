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

## 22 Nov 2026, evening: every open is a request the chain answers

**Why.** A judge pass showed the top entries pair encryption with a second mechanism. Coffer's: the weakness of every secrets tool is that whoever holds a copy and the key opens it forever.

**Format 3 and contract v4** (`0xeafe164a3f52ee096c27ba9e5ac05c0d621aa3fe`, tx `0xf2259a010acd90b6cde731a655a8c406896fe831e2a33793f8adb2ab2f679e1d`). Contents need the reader's epoch key and a release piece sealed only to the file's keeper. An open is a request signed by the reader (or a device key its wallet approved for up to 200,000 blocks); `open()` refuses it unless `memberAt[file][reader]` equals the head's epoch, marks the nonce used, stores the open (`opensOf`) and emits the release piece sealed to the reader. 25 Foundry tests, 44 unit tests.

**On the live site, two people on the CLI:**

| Step | Result | Tx |
|---|---|---|
| Owner seals to the teammate (epoch 1) | recorded | `0x281deab4388ab5ca090c64a0dfc96e5b236282040b47ccfac4a851bcf34e6655` |
| Teammate opens (inbox, pull, run) | QoreChain checked the list, recorded the open, released the piece | `0x36ff8751db6d0cfc0bc918c0b378124c079983e3f10b614a104addd91025bb0a` |
| Owner removes the teammate (epoch 2) | recorded | `0x09d615f31929f4b8869caeb564acd4d4c216b0f2d00713ce951c322058cb06ab` |
| Stolen laptop: old copy, teammate's key, `--offline` | refused by the contract (NotReader) | |
| `coffer status` | access log: one open, that teammate, epoch 1 | |

**Web, on the live site (15 of 15 checks):** a QoreX teammate approves the browser once, opens through QoreChain, and later opens make no popup; the owner sees each open under "Who opened it"; after removal even the kept copy is refused; Ada's panel ends with her stolen laptop refused.

**Costs:** an open 425,463 gas (about 0.04 QOR); a change 830,095 to 1,200,320 gas (0.08 to 0.12 QOR); paid by the Coffer server.

