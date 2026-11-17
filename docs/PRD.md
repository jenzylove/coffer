# PRD: Coffer

Build Before Q-Day, the QoreChain Developer Fest. Category: **Encrypted Apps** (1st $1,500, 2nd $750). Stacks: Best AI-Native ($500, needs `AI_USAGE.md` about AI used while building), Top-Quality (7 x $250 for 70/100+ and no other prize). Not entering the Q-Day Drill (nothing of value sits on chain for the bot to attack).

Deadline: **2 December 2026, 23:59 UTC.** Checks 3 to 5 Dec, jury 6 to 15 Dec, winners 16 Dec. Testnet only (`qorechain-diana`); mainnet is not required.

## One line

Your `.env` file, locked to wallet addresses: commit it anywhere, share it with a teammate by typing their QoreChain address, take access back later, and nobody else can read it, not even a quantum computer years from now.

## The problem (with evidence)

1. **Secrets travel in plain text.** Teams pass `.env` files and API keys over chat and paste them into tools. GitGuardian counts millions of leaked secrets on public GitHub every year (cite the latest State of Secrets Sprawl report in the README, with the year).
2. **The popular fix is breakable later.** dotenvx tells developers to commit encrypted `.env` files to git, encrypted with secp256k1 ECIES (dotenvx.com docs; the file carries `DOTENV_PUBLIC_KEY`). Public repos are permanent and mirrored, so each such file is a harvest now, decrypt later target once a quantum computer exists.
3. **The other fix is trusting a company or a server.** Hosted secrets managers keep everyone's secrets on a server you or they run.

## Who it is for, and the front door

Developers and small teams who deploy often (bots, agents, hackathon projects, startups).

First ten seconds on the site: a field that says "Paste your public GitHub repo". The page finds any dotenvx-encrypted `.env` files in it, shows each one as "secp256k1, breakable after Q-Day", and offers "Move this to a quantum-safe lock". No wallet, no sign-up.

## What QoreChain does (the reason it lives here)

- **Address to lock.** Each person publishes an ML-KEM-1024 public key with `MsgRegisterKEMKey` (hybrid-signed, bound to their account's ML-DSA-87 key). Anyone can then seal to their `qor1` address by reading the key from chain (`/qorechain/pqc/v1/kem/{address}`). No key swapping, no accounts, no middle server.
- **Quantum-safe sealing.** QoreSeal envelopes (ML-KEM-1024, AES-256-GCM). Choose the mode on purpose: `hybrid` (ML-KEM + X25519, needs a signed recipient card per recipient) or `mlkem`. Say which in the README.
- **Revocation that means something.** QoreSeal `EpochKeyManager`: every membership change makes a new epoch key sealed to current members only. A removed member keeps old epochs and cannot read new ones.
- **A signed access history.** Each grant and revoke is recorded as a native hybrid-signed transaction (memo or small message) so the history is public and checkable. Do NOT build an EVM "reader registry" contract: a fresh judge showed it protects nothing, because who can read is decided by who the envelope is sealed to.

## Full scope (one build, no v1/v2)

1. **CLI** (npm, `@jenzylove/coffer`):
   - `init`: create or load the user's seal seed (see honesty note), register ML-DSA key if missing, register the ML-KEM key, print the address.
   - `lock`: seal `.env` into `.env.coffer` (safe to commit).
   - `run -- <cmd>`: decrypt into the child process environment only; never writes plain text to disk.
   - `share <qor1 address>` and `revoke <qor1 address>`: epoch change, reseal, record the grant on chain; `revoke` prints which keys to rotate.
   - `import`: read an existing dotenvx `.env` plus `.env.keys`, decrypt locally, re-seal to the team.
   - `status`: who can read, current epoch, on-chain grant history.
2. **Web app**:
   - Scanner front door (paste a public repo URL, find dotenvx files via the GitHub API, show the curve and the risk).
   - Lock and share in the browser (client-side sealing).
   - Open as a reader.
   - Team page: members, epochs, history with explorer links.
3. **Relayer drip** so judges and new teammates never fund anything: it funds a burner account and pays for the two setup transactions (ML-DSA registration, then KEM registration). The faucet is the only official source of test QOR, so the relayer is funded from the owner's QoreX wallet or the faucet.
4. **Proof page**: the live numbers below, each with its method.
5. `AI_USAGE.md`, README (judge fast path, what is real, why only here), MIT or Apache-2.0 licence, featured image, video up to 3 minutes, testnet addresses.

## Honesty notes that must appear in the product and README

- **QoreX cannot do this yet.** It refuses `MsgRegisterKEMKey` through the wallet adapter and offers no decrypt for dApps. So the CLI and web app keep a dedicated seal seed locally (`deriveSealKeys`). Like dotenvx's `.env.keys`, that seed is the one secret you must protect. Say so plainly; never claim "no master secret".
- **Revoking cannot un-reveal** a secret a reader already opened. `revoke` therefore lists the values to rotate.
- **A deploy server that reads secrets holds its own seal seed** in its environment: same trust as `DOTENV_PRIVATE_KEY`.
- **Each new reader needs two transactions once** (ML-DSA registration first, then KEM registration). The relayer pays.
- Precompiles and the registry are on testnet; mainnet KEM registration had not been exercised end to end (QoreSeal docs, 4 Nov 2026).

## Claims and how each is proven

| Claim | Proof |
|---|---|
| A sealed `.env` opens only for current readers | Test: a removed reader fails on the new epoch; recorded run on the proof page |
| No plain text touches disk in `run` | Test plus code path; README points to the function |
| Sharing needs only an address | Live demo: share to a fresh burner address, open as that burner |
| Grant history is on chain | Explorer links for every grant and revoke |
| dotenvx files are a real exposure today | The count below, with the GitHub search query and date |

## The numbers (measured, not true by construction)

- **Exposure count**: number of public GitHub files containing `DOTENV_PUBLIC_KEY` (dotenvx-encrypted), from GitHub code search, with the query, date and method published. Each is secp256k1 and openable after Q-Day.
- **Migration catch**: for repos a visitor pastes, how many dotenvx files were found and migrated.
- **Cost**: lock and open time, and envelope size versus dotenvx (QoreSeal hybrid is `56 + 1,664 x recipients + plaintext` bytes; say the overhead honestly).

## How it meets the Encrypted Apps brief

| Jury expects | Where |
|---|---|
| ML-KEM-1024 | QoreSeal sealing of every file and epoch key |
| Registered recipient keys | Every reader's key read from the on-chain KEM registry |
| ML-DSA key binding | KEM registration is hybrid-signed by the account's ML-DSA-87 key; recipient cards in hybrid mode |
| Client-side encryption and decryption | CLI and browser only; no server ever sees plain text |

Also: the fest FAQ says jurors read the QCAI contract-audit reports. If no contract ships, say so in the README; if any contract ships, run both audit stages and answer the findings.

## What it does not do

- It does not stop a reader from copying a secret they were allowed to read.
- It is not a hosted secrets manager: no server stores secrets.
- It does not work on mainnet until the KEM registry is exercised there.
