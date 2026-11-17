# Plan: Coffer

Deadline 2 Dec 2026, 23:59 UTC. Each phase ends with a check that proves it is done.

## Already in hand (from the 17 Nov session)

- Reference clones in `~/urn-launch/`: `ref-docs` (qorechain-docs), `ref-qoreseal` (see `examples/register-and-encrypt/index.mjs`: the exact hybrid-signed `MsgRegisterKEMKey` flow, recipient card, `sealToAddresses`, `open`), `ref-bbq` (workshop apps; `01-qday-counter/scripts/window.ts` shows ML-DSA registration with proof of possession).
- `~/urn-launch/spike/`: npm project with `@qorechain/sdk` 0.14.0, `@qorechain/qoreseal` 0.1.0, `@qorechain/evm`, `@cosmjs/stargate`, `@scure/bip39`, tsx, viem installed; `keys.ts` creates testnet-only mnemonics into a local `.env` (never committed). Reuse it for Phase 0.
- Owner's QoreX testnet wallet `qor1tlwujrmp797kt05yyuucv76h7x3t430ekx79fq` holds about 99.8 test QOR; the owner sends QOR to new accounts from QoreX (the faucet needs a sign-in).

## Phase 0. Spike the chain path (90 minutes, before any product code)

Question: can one fresh account register ML-DSA, register ML-KEM, and receive and open a QoreSeal envelope sealed by a second account that only knows its address?
- Owner sends about 30 test QOR to a fresh account.
- Run the register-and-encrypt flow end to end; then seal from a second account to the first by address; open it.
- Measure transaction fees and envelope sizes.
- Write `docs/spikes/address-seal.md` (question, commands, output, verdict).
- **Check:** two registration hashes and a sealed-then-opened message, on the explorer.
- **Gate:** if it fails, stop and bring a changed plan to the owner.

## Phase 1. Repo and core

- Private repo `jenzylove/coffer`; commit identity from memory, no AI attribution lines; `.gitignore` covers `.env*`, seeds and build output before the first commit.
- Pure functions with unit tests, no network: `.env` parse and serialize, envelope format, epoch manager wrapper, dotenvx import (ECIES decrypt with the user's own `.env.keys`).
- **Check:** tests pass; a dotenvx sample round-trips into a sealed file and back.

## Phase 2. Chain integration (CLI)

- `init`, `lock`, `run`, `share`, `revoke`, `import`, `status` against testnet.
- Grants and revokes recorded as hybrid-signed native transactions.
- **Check:** a three-member team on testnet: share to B and C, revoke C, C fails on the new epoch, B opens; every step has an explorer link.

## Phase 3. Relayer drip

- Small server that funds a burner and pays for its two setup transactions; rate limited; fails closed with a clear message when out of QOR.
- **Check:** a brand new browser gets a working reader address with no funding.

## Phase 4. Web app

- Front door scanner (paste a public repo URL, GitHub API search for `DOTENV_PUBLIC_KEY` in that repo, show results).
- Lock, share and open in the browser; team page with epochs and history.
- `/proof` page with the live numbers and their methods.
- **Check:** drive every button in a headless browser, dark and light; a judge path from paste to open in about a minute.

## Phase 5. Design

- Own bold direction first (see memory: design taste); no bordered card grids; plain words.
- **Check:** screenshots shown to the owner; board references only if rejected.

## Phase 6. Audit and readiness

- `release-readiness-audit` skill on repo and live site; fix every real finding and prove the fix.
- If any contract ships, run the fest's QCAI auditor (both stages) and answer the findings in the README.
- Scan git history for secrets.
- **Gate:** owner approves the live product.

## Phase 7. Launch

- README in the owner's style (judge fast path, what is real, why only on QoreChain), `AI_USAGE.md`, licence, featured image.
- Demo video up to 3 minutes (`demo-video` skill).
- Register the project on build.qorechain.io: GitHub repo, video, featured image, testnet addresses; post updates in the fest feed.
- **Gate:** submitted before 2 Dec 23:59 UTC; project memory set to SUBMITTED.

## Risks

| Risk | Status |
|---|---|
| KEM registration and sealing to an address works end to end on testnet | Needs the Phase 0 spike |
| Browser can run QoreSeal and hybrid signing | Known: QoreSeal TS runs in the browser (fresh judge checked); confirm in Phase 4 |
| GitHub code search rate limits for the scanner | Known: authenticated search is 30 per minute; cache results |
| Relayer runs out of test QOR during judging | Known: top up from the faucet daily; fail closed with a message |
| Judges expect QoreX support | Known: QoreX refuses KEM registration; explain honestly in the README |
