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
