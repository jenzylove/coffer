<p align="center">
  <img src="docs/media/brand/mark.svg" width="72" alt="Coffer">
</p>

<h1 align="center">Coffer</h1>

<p align="center">
  <b>Push your secrets to GitHub. Only your team can open them.</b><br>
  Your <code>.env</code> sealed with ML-KEM-1024 to your teammates' QoreChain wallets. Every open is a request QoreChain answers: remove someone, or the address on a lost laptop, and nothing opens for that address any more, not even the copies on its disk.
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
| The Coffer contract (testnet) | `0x1ee9f98e8784f150d54a7ceea97026d4320746db` on `qorechain-diana` ([deploy tx](https://dashboard.qorechain.io/explorer/tx/0x45a6fc46f4e812c56d7051d99fc87c25dfee2adce4ccbc0093ce339134bf4c9d), [source](contracts/src/Coffer.sol)) |
| Proof of the testnet runs | https://coffer.jdollar.site/proof and [docs/BUILD_LOG.md](docs/BUILD_LOG.md) |
| Product spec | [docs/PRD.md](docs/PRD.md) |

## Judge fast path (one minute)

1. Open **https://coffer.jdollar.site/app** and press **Connect QoreX**. QoreX asks you to sign one short text, your recipient card. No fee and no transaction from your wallet (a brand new QoreX wallet sends one transfer first: that is how QoreX registers its post-quantum key). The Coffer contract checks it with QoreChain's own ML-DSA-87 verifier and records it. No QoreX? **Use this browser** works too: the Coffer relayer pays your setup.
2. **Seal a file**: paste any `.env`. QoreX shows you what you are signing: the file, and who can open it. You get `.env.coffer`, safe to commit, and its record on QoreChain.
3. **Share**: paste a teammate's QoreChain wallet address, or press **Share with Ada**, a demo teammate that runs on the Coffer server.
4. **Prove it**: ask Ada to open the file (she reports the key names, never the values, and her open is recorded on QoreChain). **Remove Ada**, then press **Ada's laptop is stolen**: her old copy and her key are tried twice, once by asking QoreChain and once against every release on the public record. Both are refused.

## How it works

```
your QoreX wallet ──signs──► recipient card (ML-KEM-1024 + X25519 keys) ──► Coffer contract
                                            (verified on chain by the ML-DSA-87 precompile 0x0A01)

.env ──► sealed under the epoch key + this version's release piece ──► data   (AES-256-GCM)
          epoch key ──► sealed to each reader's card keys   (ML-KEM-1024 + X25519, QoreSeal hybrid)
          release piece (new for every version) ──► sealed to the keeper, and a copy to the owner
          owner signs the change (who can read, epoch, contents) ──► the file + its head in the contract
share / remove ──► new epoch, reseal, one owner signature, recorded on chain
new values ──► new version, signed by the writer, recorded on chain

open ──► the reader signs a request: latest version + a reply key made for this one open
         contract: on the current list? the latest version? ──► records the open
         keeper ──► the release piece, sealed to that reply key; the reader opens it and drops the key
```

- **Every open is a request the chain answers.** Each version's contents need two pieces: the reader's epoch key (sealed to them in the file) and a release piece made for that version only, sealed to the file's keeper. To open, the reader's Coffer signs a request naming the latest version and a reply key it makes for this one open (signed with the wallet, or with a device key the wallet approved for a day, so opens stay silent). The Coffer contract refuses it unless the reader is on the file's current list and the version is the latest, then records the open with the release piece sealed to that reply key. The reader opens it and throws the reply key away. So:
  - **Remove someone and no copy opens for them any more.** The contract refuses their requests, and nothing on the public record opens with their key: every release there was sealed to a key that existed for one open. What they already read they may have kept, so Coffer lists the keys to change. With other secrets tools, whoever holds a copy and the key can open it forever.
  - **A stolen laptop is one removal away from useless**, even with the files, the key, a client that skips every check, and the whole public record. [`scripts/log-replay.mts`](scripts/log-replay.mts) runs that attack against any file; on the live site it opens nothing.
  - **Every reader's open is on chain**, signed with ML-DSA-87: who opened which file, at which version, and when. `coffer status` and the app show it. A release piece kept from one version opens no later version.
  - **The keeper never reads a file**: it holds release pieces only, never an epoch key, and releases them only through the contract's check. It is one server today; [THREAT_MODEL.md](THREAT_MODEL.md) says what that trusts.
- **Share with a wallet address.** QoreX cannot put an encryption key in QoreChain's KEM registry, and it cannot decrypt for apps. What it can do is sign a message with both of its keys. Coffer has it sign a QoreSeal recipient card ("seal to these keys"). The Coffer contract rebuilds the card text, reads the wallet's ML-DSA-87 key from the chain (0x0A02, proof of possession required) and verifies the signature (0x0A01). From then on anyone can seal to that wallet address. The opening keys stay in the teammate's browser; **Save my key file** moves them to another computer.
- **Sharing delivers.** Each change carries the whole sealed file on chain, and the contract keeps a list of the files shared with each address. A teammate's Coffer (or `coffer inbox`) finds the file under their own address: no download, no copy, no commit needed.
- **Invite anyone.** Paste an address that has no card yet and Coffer gives you an invite link. They connect QoreX and sign once; on your side their row turns into **Seal them in**.
- **One signature per change.** Sealing, sharing and removing each ask the owner's wallet for exactly one approval. QoreX shows the file name and every address that can open it.
- **The chain refuses old copies.** The contract binds each file to its owner and only lets its epoch and version go up. New values written by any reader are recorded too, so every teammate's Coffer finds the latest version on chain. Before opening, Coffer compares the file with its head: an old copy (with a removed reader still in it), an older version of the values, a copy relabelled with another owner, or a copy QoreChain never saw is refused.
- **Removing means something.** A removed reader never gets the next epoch key. Coffer lists every key in the file so you can change what they already saw at the provider.
- **What QoreChain refuses, tested on testnet:** an open by anyone not on the file's current list (even with an old copy and the right key), an open of anything but the latest version, a replayed open, a device past its approval, a write by anyone not on the list, a forged card, a card from an account whose key has no proof of possession, a card older than the current one, a change signed by anyone but the owner, and an older epoch or version of a file. The full list is in [THREAT_MODEL.md](THREAT_MODEL.md).

<p align="center"><img src="docs/media/prove.png" alt="The demo teammate opens the file, is removed, then refused" width="70%"></p>

## QoreChain tech in use

| Feature | What it does in Coffer |
|---|---|
| QoreX `signArbitrary` (QoreSign message signing v1: secp256k1 + ML-DSA-87) | Signs recipient cards and every change of who can read a file |
| QoreSeal recipient cards, hybrid mode, epoch keys | Sealing to teammates (ML-KEM-1024 + X25519); removal by new epochs |
| EVM precompiles `pqcVerify` (0x0A01) and `pqcKeyStatus` (0x0A02) | The contract checks every card, change, write, device approval and open request on chain |
| Contract state as the access list | `memberAt` decides at open time who may get a version's release piece; `opensOf` is the access log |
| QoreSeal one time reply keys | Each open's release piece is sealed to an ML-KEM-1024 + X25519 key made for that open, so the public record of opens stays closed to everyone |
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
npx github:jenzylove/coffer inbox                # files shared with you, found on QoreChain
npx github:jenzylove/coffer pull <id>            # save the latest copy of a shared file from the chain
```

The CLI keeps its key in `~/.coffer/identity`. On a server or in CI, set `COFFER_IDENTITY` instead.

A run on the live site, 22 Nov 2026: two people on the CLI, nothing copied between them.

| Step | Result |
|---|---|
| Contract deployed | `0xf2259a010acd90b6cde731a655a8c406896fe831e2a33793f8adb2ab2f679e1d` |
| The keeper's card | `0xf82aac2cf76d1148babbd1e35c7fc1357481a702688226d3a7263feaba3f257d` |
| Owner seals a .env to the teammate (epoch 1); the sealed file goes on chain with it | `0x281deab4388ab5ca090c64a0dfc96e5b236282040b47ccfac4a851bcf34e6655` |
| Teammate: `coffer inbox`, `coffer pull`, `coffer run`; QoreChain checks they are on the list, records the open and releases the second key piece | `0x36ff8751db6d0cfc0bc918c0b378124c079983e3f10b614a104addd91025bb0a` |
| Owner removes the teammate (epoch 2) | `0x09d615f31929f4b8869caeb564acd4d4c216b0f2d00713ce951c322058cb06ab` |
| **A stolen laptop:** the teammate's old copy, their key, and `--offline` (no checks of Coffer's own) | refused by QoreChain: "not on this file's list any more" |
| Owner's `coffer status` | the access log: one open, by that teammate, at epoch 1 |

Open any hash on the [dashboard explorer](https://dashboard.qorechain.io/explorer) with the network set to Testnet.

## Why it needs QoreChain

QoreChain is the one chain where an account registers a post-quantum signing key (ML-DSA-87, with proof of possession) and a contract can verify that key itself (the `pqcVerify` precompile at 0x0A01). That turns wallet addresses into a post-quantum key directory with no separate key server: a QoreX wallet signs one card, the contract checks it, and anyone can seal to that address. It costs about 0.06 QOR per person (about 590,000 gas). On a chain that signs with ECDSA, the signature binding an encryption key to an address is itself breakable by a quantum computer, so the directory would be the weak link.

The same check guards every change, write and open: the contract records each only with an ML-DSA-87 signature from the right account, binds each file to its owner, refuses an older epoch or version, and releases a version only to someone on its current list.

## The number

On 17 Nov 2026 GitHub code search returned **2,284** public files containing `DOTENV_PUBLIC_KEY` (dotenvx), and **1,716** with `encrypted:` values as well. Each is sealed with secp256k1 ECIES and sits in a public, mirrored repo. Queries: `DOTENV_PUBLIC_KEY` and `DOTENV_PUBLIC_KEY encrypted:`; code search counts are approximate.

## What is live

| Part | Status |
|---|---|
| Coffer contract: cards, file heads, writes, opens | Live on QoreChain testnet (`qorechain-diana`) |
| Sealing, sharing, removing, writing new values, signatures, old copy check | Live on testnet, in the app and the CLI |
| Opening through the contract with one time reply keys; the access log | Live on testnet, in the app and the CLI |
| QoreX connect and card signing | Live, checked with QoreX 0.4.3 on 22 Nov 2026 (older builds cannot sign messages) |
| Relayer for accounts without QoreX; poster that pays contract gas | Live, rate limited; neither can forge a card or a change |
| Demo teammate | Live on the Coffer server |
| Repo scanner | Live, reads public repos through the GitHub API |
| CLI | Installs from this repo with `npx github:jenzylove/coffer` |

## Scope of this build

- Testnet only.
- QoreX signs; it cannot decrypt for apps. Each person's opening keys live in their browser (or `~/.coffer`). A new computer means loading the key file, or signing a new card and having the owner seal you in again (one click).
- The server pays contract gas and rate limits it. It cannot forge a card, a change or an open, but it could refuse to post one.
- The keeper runs on the Coffer server. It never reads a file, but it could hand a release piece to someone off chain, so it is trusted not to.
- Files shared with the demo teammate are opened on the Coffer server by that teammate, which reports key names only.

## Built with

- [QoreSeal](https://github.com/qorechain) (`@qorechain/qoreseal`): ML-KEM-1024 + X25519 envelopes, recipient cards, epoch keys, the KEM registry client
- [QoreSign](https://github.com/qorechain) (`@qorechain/qoresign`): hybrid secp256k1 + ML-DSA-87 signing, message signatures, key registration
- [QoreChain SDK](https://github.com/qorechain) (`@qorechain/sdk`, `@qorechain/evm`): the poster's unified account and EVM window
- QoreX (`window.qorex.native`); the official QoreX test wallet (`@qorechain/qorex-wallet-mock`) drove our end to end browser runs on testnet (those scripts live outside this repo)
- [Foundry](https://getfoundry.sh) and [viem](https://viem.sh): the contract, its tests, and EVM calls
- [CosmJS](https://github.com/cosmos/cosmjs) and `cosmjs-types`: transaction encoding
- [noble](https://paulmillr.com/noble/) (`@noble/hashes`, `@noble/curves`) and [scure](https://github.com/paulmillr/scure-bip39) (`@scure/bip39`): hashing, secp256k1, mnemonics
- [eciesjs](https://github.com/ecies/js) and [dotenvx](https://dotenvx.com): reading dotenvx files for import (dotenvx is used in tests to make real fixtures)
- [React](https://react.dev) and [Vite](https://vitejs.dev): the web app
- [Mona Sans](https://github.com/github/mona-sans) and [Fragment Mono](https://github.com/weiweihuanghuang/fragment-mono) through Fontsource: the type

## Develop

```bash
npm install && npm test                    # 48 unit tests, no network
cd contracts && forge install foundry-rs/forge-std --no-git && forge test   # 29 contract tests
node scripts/log-replay.mts <identity file> <.env.coffer>   # the stolen laptop attack against the public record
node contracts/script/vectors.ts           # regenerate the byte for byte test vectors from the TypeScript code
cd web && npm install && npm run dev
RELAYER_MNEMONIC=... TEAMMATE_MNEMONIC=... POSTER_MNEMONIC=... node server/index.ts
```

Node 24 runs the TypeScript directly. Built with AI coding assistance.

## License

Apache 2.0
