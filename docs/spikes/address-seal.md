# Spike: sealing a .env to a qor1 address

Date: 17 Nov 2026. Network: testnet `qorechain-diana`. Script: `~/coffer-launch/spike/spike.mjs` (outside the repo).

## Question

Can a fresh account register its ML-DSA-87 key, then its ML-KEM-1024 key, and then receive and open a QoreSeal envelope sealed by another account that knows only its `qor1` address? Does revocation through `EpochKeyManager` hold?

## Design under test

- Owner A keeps an `EpochKeyManager` (mode `mlkem`, purpose `coffer:epoch-key`).
- The `.env` is sealed with `sealBatch` under the current epoch key (context `coffer:.env:<file>`).
- The epoch key is sealed to every member with ML-KEM-1024. Each member's key is read from chain with `resolveRecipient({ mode: "mlkem" })`: address only, no card.
- Revoke = `removeMember`, new epoch, reseal the file.
- Grant record = hybrid-signed native transaction with the grant in the memo.

## Accounts

| Role | Address |
|---|---|
| A, owner | qor1ljf788q9cfzv8g0f3v6n2ah5h7rw8rf2p5rg89 |
| B, reader kept | qor1smk897xyc5payx0xjyudpc0u92ja2ug9kr24a8 |
| C, reader revoked | qor1s250xnky6w7cqfp85y8lv0dfr62fjy5w2lq3x0 |

## Results

### 1. Local crypto (no chain): PASS

```
[offline] epoch 4: B opens -> OK
[offline] epoch 4: C opens -> OK
[offline] epoch 5: B opens -> OK
[offline] epoch 5: C refused -> OK (NOT_A_RECIPIENT)
[offline] C still opens the OLD epoch file: yes (expected: revoke cannot un-reveal)
[offline] sizes: .env 94 B, sealed file 194 B, epoch envelope for 3 members 4997 B, for 2 members 3365 B; seal time 79 ms
```

Sealed file overhead is 100 bytes over the plain `.env`. The epoch envelope grows about 1.6 KB per member (one ML-KEM-1024 ciphertext each).

### 2. On-chain registration (ML-DSA then KEM): PASS

Funding: 2 QOR each from the owner's drill account, tx `A830DFBE505964844A570FDB3AC3794B6E372A9A5961346CC493B5337E8AF0CF`.

ML-DSA registration is signed `classicalOnly` (`buildRegisterPqKeyMessage` with proof of possession). KEM registration is hybrid signed by the just-registered ML-DSA-87 key. Both come from one mnemonic through QoreSign's `deriveClassicalKey` and `deriveCanonicalPqKey` plus QoreSeal's `deriveSealKeys`.

| Account | ML-DSA tx | KEM tx |
|---|---|---|
| A | `BF50E7F789BC7F20D60B4BFB4CEF1C715222CAE08A6E0C4EB1A4B3967E82FAC4` | `7FEA6E38D9371DF260B8D15C1DB9C21D85221FECC5A40CD0EBD78DD28B58B2EB` |
| B | `1BECDFF311C6A0F00F5EB3DA8C16BBB57A98AD8A019280C4AE109E7A4049D522` | `BEF9259C56672C03DB2AA9C471B262F31B39F5FCD5AA745FBD2F973B9064B95B` |
| C | `68ED75AFC3A3379FAE1EE867C8C3ACD31CBEC513A8E027D821A7E868443D04A0` | `A1B6DFB7293566CA0E431D114515027BA5331468E570EC4104922D770E66F8BE` |

Check any hash at `https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/<hash>`.

Cost per new reader: ML-DSA 278,305 gas (0.0286 QOR) plus KEM 247,481 gas (0.0254 QOR) = **0.054 QOR, once**. Each account ended at 1.945968 QOR.

### 3. Seal by address only, revoke: PASS

The sender held only the three `qor1` addresses; every ML-KEM key was read from `/qorechain/pqc/v1/kem/{address}` (`resolveRecipient`, mode `mlkem`, no recipient card).

```
[chain] epoch 4: B opens -> OK
[chain] epoch 4: C opens -> OK
[chain] epoch 5: B opens -> OK
[chain] epoch 5: C refused -> OK (NOT_A_RECIPIENT)
[chain] C still opens the OLD epoch file: yes (expected: revoke cannot un-reveal)
[chain] sizes: .env 94 B, sealed file 194 B, epoch envelope for 3 members 4997 B, for 2 members 3365 B; seal time 2615 ms
```

2.6 s is almost all three REST reads of the KEM keys; the crypto itself took 79 ms offline.

### 4. Grant record memo: PASS

Hybrid-signed self-send of 1 uqor with memo `coffer grant v1 file=spike epoch=2 add=<B> remove=<C>`. Tx `D23DE195E804D2986A28FAD808A597734619B50EB0D91E328A8D8FA06E0C973D`, 168,960 gas (0.0174 QOR). The memo read back from chain matches exactly.

Gotcha: messages in `TxBody.fromPartial` must be protobuf-encoded (`MsgSend.encode(...).finish()`), not plain objects, or simulation fails with "empty address string is not allowed".

## Verdict

**PASS. The core assumption holds on testnet.** A fresh account goes from nothing to sealable-by-address in two transactions costing 0.054 QOR. A sender needs nothing but the address. Revocation through `EpochKeyManager` locks a removed reader out of new epochs, and the grant history can live in hybrid-signed memos. Build on it.

Decisions this settles for Phase 1:
- Seal mode `mlkem` (address only). Hybrid mode would need every reader to publish a signed recipient card somewhere; that breaks "type their address". Say so in the README.
- File format: the `.env` sealed with `sealBatch` under the epoch key, plus the epoch key envelope for current members. Both go in `.env.coffer`.
- Relayer drip per reader: 0.054 QOR covers both setup transactions; drip 0.1 QOR.
- Grant memo per share or revoke: about 0.017 QOR.
- The owner's `EpochKeyManager` history (all epoch keys) must itself be stored sealed to the owner, never in plain text.
