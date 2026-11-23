# Threat model

What Coffer protects, from whom, and where it stops. Every claim names the code or the test that backs it.

## What is protected

The values in a `.env` file (API keys, passwords, database URLs). The file names, who can open it, when it changed and who opened it are public on QoreChain by design.

## The pieces

| Piece | Holds | Can it read a file? |
|---|---|---|
| A reader (owner or teammate) | their own epoch key envelope (sealed to their card's ML-KEM-1024 + X25519 keys) | only with the release piece of the version, which they get by an open the contract accepts |
| The owner | the same, plus its own copy of each version's release piece | yes, without a request (so the owner's opens are not logged) |
| The keeper (on the Coffer server) | the ability to unwrap release pieces | no: it never holds an epoch key ([`vault.test.ts`](src/core/vault.test.ts), "the keeper alone cannot read") |
| The Coffer contract | cards, file heads, who is on each list, every open | no: it stores ciphertext and hashes only |
| The poster (on the Coffer server) | gas for contract calls | no: it only submits what others signed |

## Attacks and what stops them

| Attack | What stops it | Where |
|---|---|---|
| A teammate is removed and opens a copy they kept | The contract releases a version's piece only to addresses on the file's current list (`memberAt == head epoch`), whatever copy they hold | `Coffer.sol` `open`; `test_removed_reader_cannot_open_any_copy_old_or_new`; testnet runs in `docs/BUILD_LOG.md` |
| A laptop is stolen with the files and the reader's key on it, and the thief asks Coffer | The owner removes that address; from then on the contract refuses every request for it, even from a client that skips every check | same; the testnet run used `--offline`, which skips Coffer's own checks |
| The thief skips Coffer entirely: reads every past open on the public record and unwraps the release pieces with the stolen key | Each release on the record is sealed to a reply key the reader made for that one open and dropped. The request the reader signs names the reply key's hash, so nobody can point a release at a key of their own | `sealReleaseTo`, `openReleaseTo` in `vault.ts`; "the public record of an open holds nothing...", `test_reply_key_is_part_of_the_signed_request`; [`scripts/log-replay.mts`](scripts/log-replay.mts) on testnet. An outside judge broke the previous design (v4) this way on 23 Nov 2026; v5 closes it |
| A reader keeps a release piece and reads later versions without asking, or after removal | Every version has its own release piece, and the contract releases only the latest version | "each version has its own release piece..."; `test_open_only_the_latest_version_and_bad_inputs_refused` |
| Someone swaps in their own encryption key for a teammate | Cards are signed with the account's ML-DSA-87 key; the contract checks them with `pqcVerify` against the key registered with proof of possession | `Coffer.sol` `setCard`; `test_card_for_other_keys_refused` |
| An old card comes back after a key was replaced | The contract keeps only the newest card per account | `test_card_set_and_replaced_by_newer_only` |
| An old copy or an older version of the values is put back | The contract only lets a file's epoch and version go up, and records every write; Coffer compares every file with its head before opening | `Coffer.sol` `setHead`, `write`; `checkHead` in `vault.ts`; `test_head_binds_owner_delivers_and_only_moves_forward`, `test_reader_writes_a_new_version_and_it_is_delivered` |
| A removed reader writes new values | The contract records a write only from an address on the current list, signed by it | `test_write_refused_unless_a_current_reader_signs_the_current_access` |
| A current teammate writes a version whose release piece is sealed to the wrong keys, to lock everyone out | The Coffer server records a write only if the keeper can unwrap its piece; if the owner's copy was sealed wrong, the owner's Coffer asks the keeper like any reader, so share and revoke still work | `postWrite` in `server/index.ts`; `releaseFor` in the CLI, `ownerPiece` in the web worker. Found by an outside judge on 23 Nov 2026. A teammate with a modified client can still write values nobody opens, which is the same power as writing wrong values: remove them and seal again from a good copy |
| Someone else relabels a file as theirs, or edits the reader list | The owner's ML-DSA-87 signature covers the access block; the contract binds each file id to its first owner | `verifyCoffer`; `test_head_of_someone_elses_file_refused` |
| A reader slipped into the list without the owner's approval | The reader list is part of the text the owner signs and the contract rebuilds | `test_head_with_changed_fields_or_readers_refused` |
| An open request is replayed | Each request carries a nonce the contract marks used | `test_current_reader_opens_with_own_key_and_it_is_logged` |
| A device key is stolen | It only works until the block its wallet approved (at most about 3 days), only for that wallet's opens, and only while that wallet is on the list | `test_device_approved_by_the_account_opens_until_it_expires` |
| A quantum computer breaks secp256k1 or X25519 | Sealing is hybrid with ML-KEM-1024; every authority (cards, changes, writes, opens, devices) is an ML-DSA-87 signature checked on chain | QoreSeal hybrid mode; `pqcVerify` |

## Where Coffer stops

- **What was already read.** A reader who opened a version may have kept the values. Removal cannot take those back, so Coffer lists the keys to change at each provider.
- **Before removal.** A stolen laptop whose address is still on the list opens like its owner until that address is removed.
- **The keeper.** It could hand a release piece to someone off chain. It can still never read a file (it lacks the epoch key), and every release it makes through the contract is public and sealed to a one time key. One keeper is a trust point today; splitting it across independent keepers is the next step.
- **The owner.** The owner holds its own copy of each version's release piece, so the owner's opens are not logged, and a stolen owner key means a stolen file.
- **Availability.** If the Coffer server is down, readers cannot open (the owner still can). The server can refuse to post a change, a write or an open; it cannot forge any of them. Opens are rate limited per network and per day, so a flood can delay opens until the next day.
- **A future keeper key leak.** Every version's keeper envelope stays on the public record. Whoever later held both the keeper's key and a former reader's key could open the versions that reader once had. Rotating the keeper and resealing is the remedy; threshold keepers would remove the single key.
- **Release pieces are bound to the file, its epoch and version, and the chain, not yet to the contract address.** Coffer has changed the release format with each new contract so far, so pieces made for an old contract do not unwrap for a new one.
- **The browser reads the chain through the Coffer server** (QoreChain's REST and EVM endpoints send no CORS headers). The web app is built for one contract and one keeper and refuses a server that names others; the CLI can use any node with `COFFER_REST` and `COFFER_EVM`.
- **Keys in the browser** sit in `localStorage`. "Save my key file" moves them; a passkey wrap is not built.
- **Metadata is public:** who can open a file, when it changed, and every reader's open.
- **Size:** a sealed file holds about 9 people (64 KB on chain); a larger team splits files.

## QCAI audit (QoreChain AI, 23 Nov 2026)

Report: [docs/audit/qcai-2026-11-23.pdf](docs/audit/qcai-2026-11-23.pdf), on contract v4. Score 78 of 100, risk medium, 5 findings. The auditor read the chain as "ethereum", so it did not score post-quantum readiness. Our answer to each finding, checked against the code and the tests (v5 keeps every answer):

| Finding | Severity | Answer |
|---|---|---|
| Missing access control on setCard, setHead, setDevice | High | By design: anyone may submit, and the access control is the ML-DSA-87 signature each function verifies with `pqcVerify` against the account's proven key. A call without it reverts: `test_card_with_wrong_signature_refused`, `test_head_of_someone_elses_file_refused`, `test_device_approval_must_be_signed_by_the_account_and_short`, `test_open_needs_the_readers_signature`. The contract says so on each function. |
| Overflow in the device duration check | Medium | Not possible: Solidity 0.8 checks arithmetic, and `block.number + 200_000` is far from the uint256 limit. |
| Front-running of file changes | Medium | Submitting an owner's signed change first records exactly that change. Someone holding a reader's signed open request could submit it first with a junk release piece, using up that nonce; the reader's Coffer simply retries. They cannot point the release at a key of their own: the reply key is part of the signed request (`test_reply_key_is_part_of_the_signed_request`). |
| Unbounded loop over readers | Low | Bounded: at most 64 readers (`MAX_READERS`), and about 9 in practice because a sealed file is capped at 64 KB. |
| No ERC interface | Info | Correct: Coffer is not a token. |
