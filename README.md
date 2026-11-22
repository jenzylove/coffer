<p align="center">
  <img src="docs/media/brand/mark.svg" width="72" alt="Coffer">
</p>

<h1 align="center">Coffer</h1>

<p align="center">
  <b>Push your secrets to GitHub. Only your team can open them.</b><br>
  Your <code>.env</code> sealed with ML-KEM-1024 to your teammates' QoreChain wallets. Share by wallet address, take access back, and let the chain refuse old copies.
</p>

<p align="center">
  <a href="https://coffer.jdollar.site"><img alt="Live site" src="https://img.shields.io/badge/live-coffer.jdollar.site-ff4a1c"></a>
  <a href="https://coffer.jdollar.site/proof"><img alt="Proof" src="https://img.shields.io/badge/proof-testnet%20runs-5fd4e6"></a>
  <img alt="Built for Build Before Q-Day" src="https://img.shields.io/badge/built%20for-Build%20Before%20Q--Day-111">
  <img alt="Encrypted Apps" src="https://img.shields.io/badge/track-Encrypted%20Apps-111">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-555"></a>
</p>

<p align="center">
  <img src="docs/media/hero.png" alt="Coffer landing page" width="100%">
</p>

## Start here

| | |
|---|---|
| Live site | https://coffer.jdollar.site |
| The app (QoreX, or no wallet at all) | https://coffer.jdollar.site/app |
| The Coffer contract (testnet) | `0xe94094e3e67d0c9c37b478616e3f5240127f40c9` on `qorechain-diana` ([deploy tx](https://dashboard.qorechain.io/explorer/tx/0x6538ffa60a4e6424080eaa11f74a9bf921275e551d6a550c52289551a60223cd), [source](contracts/src/Coffer.sol)) |
| Proof of the testnet runs | https://coffer.jdollar.site/proof and [docs/BUILD_LOG.md](docs/BUILD_LOG.md) |
| Product spec | [docs/PRD.md](docs/PRD.md) |

## Judge fast path (one minute)

1. Open **https://coffer.jdollar.site/app** and press **Connect QoreX**. QoreX asks you to sign one short text, your recipient card. No fee and no transaction from your wallet. The Coffer contract checks it with QoreChain's own ML-DSA-87 verifier and records it. No QoreX? **Use this browser** works too: the Coffer relayer pays your setup.
2. **Seal a file**: paste any `.env`. QoreX shows you what you are signing: the file, and who can open it. You get `.env.coffer`, safe to commit, and its record on QoreChain.
3. **Share**: paste a teammate's QoreChain wallet address, or press **Share with Ada**, a demo teammate that runs on the Coffer server.
4. **Prove it**: ask Ada to open the file (she reports the key names, never the values). **Remove Ada**, ask again: refused. **Send Ada the old copy**: refused, because QoreChain has a newer version.

## How it works

```
your QoreX wallet ──signs──► recipient card (ML-KEM-1024 + X25519 keys) ──► Coffer contract
                                            (verified on chain by the ML-DSA-87 precompile 0x0A01)

.env ──► sealed under a fresh epoch key ──► data      (AES-256-GCM)
          epoch key ──► sealed to each reader's card keys   (ML-KEM-1024 + X25519, QoreSeal hybrid)
          owner signs the change (who can read, epoch, contents) ──► the file + its head in the contract
share / remove ──► new epoch, reseal, one owner signature, recorded on chain
```

- **Share with a wallet address.** QoreX cannot put an encryption key in QoreChain's KEM registry, and it cannot decrypt for apps. What it can do is sign a message with both of its keys. Coffer has it sign a QoreSeal recipient card ("seal to these keys"). The Coffer contract rebuilds the card text, reads the wallet's ML-DSA-87 key from the chain (0x0A02, proof of possession required) and verifies the signature (0x0A01). From then on anyone can seal to that wallet address. The opening keys stay in the teammate's browser; **Save my key file** moves them to another computer.
- **Invite anyone.** Paste an address that has no card yet and Coffer gives you an invite link. They connect QoreX and sign once; on your side their row turns into **Seal them in**.
- **One signature per change.** Sealing, sharing and removing each ask the owner's wallet for exactly one approval. QoreX shows the file name and every address that can open it.
- **The chain refuses old copies.** The contract binds each file to its owner and only lets its epoch go up. Before opening, Coffer compares the file with its head on chain: an old copy (with a removed reader still in it), a copy relabelled with another owner, or a copy QoreChain never saw is refused.
- **Removing means something.** A removed reader never gets the next epoch key. Coffer lists every key in the file so you can change what they already saw at the provider.
- **What QoreChain refuses, tested on testnet:** a forged card, a card from an account whose key has no proof of possession, a card older than the current one, a change signed by anyone but the owner, and an older epoch of a file.

<p align="center"><img src="docs/media/prove.png" alt="The demo teammate opens the file, is removed, then refused" width="70%"></p>

## QoreChain tech in use

| Feature | What it does in Coffer |
|---|---|
| QoreX `signArbitrary` (QoreSign message signing v1: secp256k1 + ML-DSA-87) | Signs recipient cards and every change of who can read a file |
| QoreSeal recipient cards, hybrid mode, epoch keys | Sealing to teammates (ML-KEM-1024 + X25519); removal by new epochs |
| EVM precompiles `pqcVerify` (0x0A01) and `pqcKeyStatus` (0x0A02) | The contract checks every card and every change on chain |
| EVM contract and a scoped authorisation window | Cards and file heads; the poster account can only call the Coffer contract |
| Hybrid native transactions, ML-DSA-87 key registration with proof of possession | Setup for accounts without QoreX (browser and CLI) |
| KEM registry (`MsgRegisterKEMKey`) | Browser and CLI accounts also publish their ML-KEM key there, so any QoreSeal app can seal to them |

## The CLI

```bash
npx github:jenzylove/coffer init                 # make your key, publish your card; the relayer pays setup
npx github:jenzylove/coffer lock --to qor1...    # .env -> .env.coffer (commit this), recorded on chain
npx github:jenzylove/coffer share qor1...        # add a reader by wallet address
npx github:jenzylove/coffer revoke qor1...       # remove a reader, list keys to change
npx github:jenzylove/coffer run -- npm start     # secrets in the child process env only
npx github:jenzylove/coffer import               # move a dotenvx .env + .env.keys over
npx github:jenzylove/coffer set KEY              # change a value (asks for it); no plain text on disk
npx github:jenzylove/coffer status               # readers, epoch, signature check, the record on chain
```

The CLI keeps its key in `~/.coffer/identity`. On a server or in CI, set `COFFER_IDENTITY` instead.

A run on testnet, 22 Nov 2026 (CLI owner and the demo teammate):

| Step | Result |
|---|---|
| Contract deployed | `0x6538ffa60a4e6424080eaa11f74a9bf921275e551d6a550c52289551a60223cd` |
| Demo teammate's card | `0x8194c99e447ed6b221b82439251d0a28d1254e0628475393b1b57eb9fcec5d0f` |
| Owner's card | `0xb1b04a1b50151351cb4d488784b4c4ecf8cc6db87ed79db21500519d352bb94f` |
| File sealed to the teammate (epoch 1) | `0x6bbe021b1fa7b944828fb5b0f7e895d1895af6f0bf11516ca623b358deabeb04` |
| Teammate removed (epoch 2) | `0x985fb953b314d41d29b4f32648dfdd3ab8bca763a4aa9488586366f1880c4dcf` |
| Teammate opens epoch 2 | refused: not a reader |
| Teammate sends back the epoch 1 copy | refused: QoreChain has a newer one (epoch 2) |

Open any hash on the [dashboard explorer](https://dashboard.qorechain.io/explorer) with the network set to Testnet.

## Why it needs QoreChain

Coffer needs three things from the chain: post-quantum account keys (ML-DSA-87, registered with proof of possession), a way for a contract to verify them (the 0x0A01 precompile), and a wallet that signs with both keys (QoreX). Together they turn "a teammate's wallet address" into "keys you can seal to", and they make the chain, not Coffer, the judge of which copy of a file is current.

## The number

On 17 Nov 2026 GitHub code search returned **2,284** public files containing `DOTENV_PUBLIC_KEY` (dotenvx), and **1,716** with `encrypted:` values as well. Each is sealed with secp256k1 ECIES and sits in a public, mirrored repo. Queries: `DOTENV_PUBLIC_KEY` and `DOTENV_PUBLIC_KEY encrypted:`; code search counts are approximate.

## What is live

| Part | Status |
|---|---|
| Coffer contract: cards and file heads | Live on QoreChain testnet (`qorechain-diana`) |
| Sealing, sharing, removing, signatures, old copy check | Live on testnet, in the app and the CLI |
| QoreX connect and card signing | Live (QoreX 0.4.3 or later) |
| Relayer for accounts without QoreX; poster that pays contract gas | Live, rate limited; neither can forge a card or a change |
| Demo teammate | Live on the Coffer server |
| Repo scanner | Live, reads public repos through the GitHub API |
| CLI | Installs from this repo with `npx github:jenzylove/coffer` |

## Scope of this build

- Testnet only.
- QoreX signs; it cannot decrypt for apps. Each person's opening keys live in their browser (or `~/.coffer`). A new computer means loading the key file, or signing a new card and having the owner seal you in again (one click).
- The server pays contract gas and rate limits it. It cannot forge a card or a change, but it could refuse to post one.
- Files shared with the demo teammate are opened on the Coffer server by that teammate, which reports key names only.

## Built with

- [QoreSeal](https://github.com/qorechain) (`@qorechain/qoreseal`): ML-KEM-1024 + X25519 envelopes, recipient cards, epoch keys, the KEM registry client
- [QoreSign](https://github.com/qorechain) (`@qorechain/qoresign`): hybrid secp256k1 + ML-DSA-87 signing, message signatures, key registration
- [QoreChain SDK](https://github.com/qorechain) (`@qorechain/sdk`, `@qorechain/evm`): the poster's unified account and EVM window
- QoreX (`window.qorex.native`), and the QoreX test wallet (`@qorechain/qorex-wallet-mock`) for end to end tests
- [Foundry](https://getfoundry.sh) and [viem](https://viem.sh): the contract, its tests, and EVM calls
- [CosmJS](https://github.com/cosmos/cosmjs) and `cosmjs-types`: transaction encoding
- [noble](https://paulmillr.com/noble/) (`@noble/hashes`, `@noble/curves`) and [scure](https://github.com/paulmillr/scure-bip39) (`@scure/bip39`): hashing, secp256k1, mnemonics
- [eciesjs](https://github.com/ecies/js) and [dotenvx](https://dotenvx.com): reading dotenvx files for import (dotenvx is used in tests to make real fixtures)
- [React](https://react.dev) and [Vite](https://vitejs.dev): the web app

## Develop

```bash
npm install && npm test                    # 38 unit tests, no network
cd contracts && forge install foundry-rs/forge-std --no-git && forge test   # 16 contract tests
node contracts/script/vectors.ts           # regenerate the byte for byte test vectors from the TypeScript code
cd web && npm install && npm run dev
RELAYER_MNEMONIC=... TEAMMATE_MNEMONIC=... POSTER_MNEMONIC=... node server/index.ts
```

Node 24 runs the TypeScript directly. Built with AI coding assistance.

## License

Apache 2.0
