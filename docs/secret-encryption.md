# Secret encryption in Postgres

Credentials Maple holds for a customer (OAuth tokens, warehouse passwords, webhook secrets,
alert destination secrets, ...) are sealed with AES-256-GCM before they reach Postgres. The
code is `packages/backend/src/platform/SecretBox.ts`; the list of sealed columns is
`packages/backend/src/platform/secret-slots.ts`.

## Storage

Each secret is a `(ciphertext, iv, tag)` column triple. A ciphertext that is not in the
envelope below is refused: values from before it carried no row binding.

The `ciphertext` column holds `v2.<keyId>.<base64>`: sealed under a subkey derived for the
slot, and bound to the slot, the org and the row.

- **Slot**: one secret column, named `table.column`. The name is part of every ciphertext, so
  it never changes once rows exist.
- **Subkey**: `HKDF-SHA256(master, info = "maple/secret-box/v2/slot/<slot>")`. A value sealed
  for one column does not open as another.
- **Binding**: the AAD is the slot name plus the row's identity (`org_id`, then the id or the
  upsert conflict target), length-prefixed. A triple copied onto another row or org fails to
  open. Someone with database write access but no key therefore cannot point Maple at another
  org's credentials.
- **Exceptions**: `cli_device_authorizations.token` has no org until it is approved, so it
  binds to the row's primary key alone. `cloudflare_logpush_connectors.secret_*` is not sealed
  through `SecretBox`: nothing reads or writes those three columns.
- **Key id**: `HKDF-SHA256(master, info = "maple/secret-box/v2/key-id")`, first 6 bytes,
  base64url. It names the master key that sealed the value and reveals nothing about it.

The ingest gateway (Rust, `apps/ingest/src/main.rs`) opens one slot itself:
`org_clickhouse_settings.ch_password`. Both implementations are pinned to the same test
fixture (`secret-slots.test.ts` and the gateway's `secret_keyring_*` tests).

## Keys

| Variable                           | Purpose                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `MAPLE_INGEST_KEY_ENCRYPTION_KEY`  | The primary master key. Seals every new value. Base64, 32 bytes.  |
| `MAPLE_INGEST_KEY_DECRYPTION_KEYS` | Optional, comma-separated. Master keys accepted for opening only. |

Every deployable that opens secrets reads both: the API, AI, alerting and chat-bot Workers,
the schema-apply workflow and the ingest gateway.

## Adding a secret column

1. Add the `*_ciphertext`, `*_iv`, `*_tag` columns.
2. Declare a slot in `secret-slots.ts`. Its binding must be known before the row is written and
   must not change for the life of the row; a table written with `ON CONFLICT DO UPDATE` binds
   to the conflict target, not to a generated id.
3. Seal with `sealSecret(keyring, slot, ref, plaintext, onError)` and open with `openSecret`.
   Take the ref from the stored row or the authenticated tenant, never from request input.
4. Add the column to `RESEAL_TARGETS` in
   `packages/backend/src/services/secrets/reseal-targets.ts`. A slot without a target there does
   not compile: a column that is never resealed stops opening once its old key is retired.

## Resealing

`SecretResealService.resealDue` runs hourly in the alerting Worker (lane `secret_reseal`). It
rewrites every stored value whose ciphertext does not start with the primary key's prefix
(`v2.<primary key id>.`), which is every value sealed by a key that is no longer primary. A
value left over from before the v2 envelope is not opened: it counts as failed and as
remaining on every pass, which is how one gets noticed. Each write is conditional on the row still holding the value that was read, so
it never overwrites a concurrent change. A value that will not open is left as it is, logged as
`Stored secret could not be resealed` with its slot and row, and retried on the next pass.

Every pass logs `Alerting tick completed` with `maple.alerting.tick = secret_reseal` and the
counts `maple.alerting.secretsResealed`, `secretsResealFailed` and `secretsResealRemaining`,
zeros included. `secretsResealRemaining` is counted in Postgres after the pass, so it is the
number to wait on.

## Rotating the key

The deployables do not deploy at the same instant, so a reader must hold a key before any
writer seals with it.

1. Generate the new key (`openssl rand -base64 32`). Add it to
   `MAPLE_INGEST_KEY_DECRYPTION_KEYS` everywhere and deploy. Nothing is sealed with it yet.
2. Swap: the new key becomes `MAPLE_INGEST_KEY_ENCRYPTION_KEY`, the old one moves to
   `MAPLE_INGEST_KEY_DECRYPTION_KEYS`. Deploy. New values are sealed with the new key and the
   hourly pass reseals the rest.
3. Wait until `secret_reseal` reports `secretsResealRemaining = 0` on two passes in a row.
   Investigate any `secretsResealFailed` before going on: those values are still readable only
   with the old key.
4. Remove the old key from `MAPLE_INGEST_KEY_DECRYPTION_KEYS` and deploy.

## Upgrading a deployment

The pre-v2 envelope was read, and rewritten by the hourly pass, only by the releases between
the one that introduced v2 and the one that stopped reading it. A deployment that skips those
releases keeps values nothing can open any more, the ingest keys among them. Run one of them
until `secretsResealRemaining` is 0 before upgrading further.
