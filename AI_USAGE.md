# How AI was used to build Coffer

Coffer was built by one developer working with an AI coding agent (Claude Code) in the terminal. The developer chose the product, made every product and design call, and approved each phase; the agent planned, wrote code, ran it against QoreChain testnet and reported back.

## Where AI did the work

| Part | How |
|---|---|
| Chain spike | The agent wrote and ran the address-seal spike against testnet: ML-DSA-87 registration, ML-KEM-1024 registration, sealing to an address read from the KEM registry, epoch revocation. Results with tx hashes in `docs/spikes/address-seal.md`. |
| Core crypto design | The agent designed the `.env.coffer` format (epoch key, ML-KEM envelope per reader, owner and writer ML-DSA-87 signatures, random signed file id) and wrote `src/core/vault.ts` with tamper tests. |
| Parser and dotenvx import | Delegated by the lead agent to a second agent with a written spec; tested against real dotenvx output; reviewed before merging. |
| CLI and chain module | Written by the agent; proven with a three-member team run on testnet (`docs/BUILD_LOG.md`). |
| Server | Relayer, scanner, REST proxy and demo teammate, written and tested end to end on testnet by the agent. |
| Web app | Built by a separate agent from a design brief that carried the developer's design rules; reviewed screenshot by screenshot. |
| Recipient cards and the Coffer contract | When QoreX turned out unable to publish an encryption key, the agent designed signed recipient cards and wrote `Coffer.sol`, whose texts are rebuilt byte for byte from the TypeScript code (`contracts/script/vectors.ts`), with Foundry tests against mocked precompiles and real runs on testnet. |
| Opening through the contract (keeper, release pieces, device keys, access log) | Designed by the agent after the developer asked what puts the strongest entries ahead; the developer approved the direction ("every open is a request the chain answers"). |
| Outside review | The agent ran fresh agents with no build context as strict judges and as an appeal, plus QoreChain's own QCAI contract audit (the developer ran it from their dashboard login); every finding is answered in `THREAT_MODEL.md`. |

## What AI testing caught

Running the real chain path, not mocks, surfaced bugs that unit tests did not:

- A file id derived from owner and name made a recreated `.env` look like a rollback forever. Fixed with a random, signed file id.
- The chain refuses transactions from accounts without an ML-DSA key, so the relayer had to register its own key first.
- A 0.1 QOR drip left too little for a single grant record; the fee estimate reserves 60,000 uqor. Fixed by capping the estimate and raising the drip.
- The REST node can report a stale sequence right after a commit; transactions now retry.
- A simulated "attack" with the ECDSA key alone passed because simulation skips signature checks. The agent re-ran it as a real broadcast, which the chain refused, before entering the relayer in the Q-Day drill.
- **The biggest catch came from an outside judge agent, not from our own tests.** On 23 Nov a fresh judge read the public `Opened` events of contract v4 and unwrapped a removed reader's release piece with that reader's own key, opening the old copy with no request. Our tests had only tried the path through the keeper. The agent redesigned it the same day: every open now seals the piece to a reply key made for that one open, each version has its own piece, and writes are recorded on chain (contract v5). The judge's attack is now a unit test and `scripts/log-replay.mts`, rerun on testnet: nothing opens.
- Removing a reader right after a teammate's write failed, because the write carried over into the owner's change. Found by the v5 run on testnet, fixed with a test.
- Every change is checked against a 64 KB limit before the wallet is asked to sign, after a test showed an eleventh reader failing only after the owner approved.

## What stayed with the developer

The idea, the name, the product scope, every design approval, the go on each redesign, funding decisions (which accounts to fund and from where), running the QCAI audit, what to make public and when.
