# Threat model

What Coffer protects, from whom, and where it stops. Every claim names the code or the test that backs it.

## What is protected

The values in a `.env` file (API keys, passwords, database URLs). The file names, who can open it and when it changed are public on QoreChain by design.

## The pieces

| Piece | Holds | Can it read a file? |
|---|---|---|
| A reader (owner or teammate) | their own epoch key envelope (sealed to their card's ML-KEM-1024 + X25519 keys) | only with a release piece, which they get by an open the contract accepts |
| The keeper (on the Coffer server) | the ability to unwrap release pieces | no: it never holds an epoch key ([`vault.test.ts`](src/core/vault.test.ts), "the keeper alone cannot read") |
| The Coffer contract | cards, file heads, who is on each list, every open | no: it stores ciphertext and hashes only |
| The poster (on the Coffer server) | gas for contract calls | no: it only submits what others signed |

## Attacks and what stops them

| Attack | What stops it | Where |
|---|---|---|
| A teammate is removed and opens a copy they kept | The contract releases the second key piece only to addresses on the file's current list (`memberAt == head epoch`), whatever copy they hold | `Coffer.sol` `open`; `test_removed_reader_cannot_open_any_copy_old_or_new`; testnet run in `docs/BUILD_LOG.md` |
| A laptop is stolen with the files and the reader's key on it | The owner removes that address; from then on no copy opens for it, even with the key and a client that skips every check | same; the testnet run used `--offline`, which skips Coffer's own checks |
| Someone swaps in their own encryption key for a teammate | Cards are signed with the account's ML-DSA-87 key; the contract checks them with `pqcVerify` against the key registered with proof of possession | `Coffer.sol` `setCard`; `test_card_for_other_keys_refused` |
| An old card comes back after a key was replaced | The contract keeps only the newest card per account | `test_card_set_and_replaced_by_newer_only` |
| An old version of the file is put back (with a removed reader still in it) | The contract only lets a file's epoch go up; Coffer compares every file with its head before opening | `Coffer.sol` `setHead`; `checkHead` in `vault.ts`; `test_head_binds_owner_delivers_and_only_moves_forward` |
| Someone else relabels a file as theirs, or edits the reader list | The owner's ML-DSA-87 signature covers the access block; the contract binds each file id to its first owner | `verifyCoffer`; `test_head_of_someone_elses_file_refused` |
| A reader slipped into the list without the owner's approval | The reader list is part of the text the owner signs and the contract rebuilds | `test_head_with_changed_fields_or_readers_refused` |
| An open request is replayed | Each request carries a nonce the contract marks used | `test_current_reader_opens_with_own_key_and_it_is_logged` |
| A device key is stolen | It only works until the block its wallet approved (at most about 3 days), and only for that wallet's opens | `test_device_approved_by_the_account_opens_until_it_expires` |
| A quantum computer breaks secp256k1 or X25519 | Sealing is hybrid with ML-KEM-1024; every authority (cards, changes, opens, devices) is an ML-DSA-87 signature checked on chain | QoreSeal hybrid mode; `pqcVerify` |

## Where Coffer stops

- **What was already opened.** A reader who opened a version may have kept the values. Removal cannot take those back, so Coffer lists the keys to change at each provider.
- **The keeper.** It could hand a release piece to someone off chain. It can still never read a file (it lacks the epoch key), and every release it makes through the contract is public. One keeper is a trust point today; splitting it across independent keepers is the next step.
- **The owner.** The owner's own copy of each release piece sits in its owner envelope, so the owner's opens are not logged, and a stolen owner key means a stolen file.
- **Availability.** If the Coffer server is down, readers cannot open (the owner still can). The server can refuse to post a change or an open; it cannot forge either.
- **The browser reads the chain through the Coffer server** (QoreChain's REST and EVM endpoints send no CORS headers). The CLI can use any node with `COFFER_REST` and `COFFER_EVM`.
- **Keys in the browser** sit in `localStorage`. "Save my key file" moves them; a passkey wrap is not built.
- **Metadata is public:** who can open a file, when it changed, and every open.
- **Size:** a sealed file holds about 9 people (64 KB on chain); a larger team splits files.
