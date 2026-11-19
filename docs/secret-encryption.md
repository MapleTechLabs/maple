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
- **Destination (v3)**: a slot whose value Maple sends somewhere names a `destination` in
  `secret-slots.ts`, and its values use `v3.<keyId>.<base64>`: the AAD is the slot, the row,
  the fixed part `destination`, then the destination. Write access to the database is then not enough to point a stored
  credential at another host: the edited row stops opening. The slots and what they bind:

    | Slot                                  | Destination                                                                                                                           |
    | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
    | `org_clickhouse_settings.ch_password` | `ch_url` exactly as stored (the gateway opens it)                                                                                     |
    | `scrape_targets.auth_credentials`     | scheme, host and port of `url`                                                                                                        |
    | `external_data_sources.secret`        | `secretDestination(config)`                                                                                                           |
    | `uptime_monitors.headers`             | HTTP: scheme, host and port. Multi-step: every step's URL and extractions, since a later host can be a variable an earlier step fills |

    A destination is derived from stored columns only, and never differently: a change to how it
    is derived stops every stored value of that slot opening. Code that changes the destination
    seals again for the new one.

- **Key id**: `HKDF-SHA256(master, info = "maple/secret-box/v2/key-id")`, first 6 bytes,
  base64url. It names the master key that sealed the value and reveals nothing about it.

The ingest gateway (Rust, `apps/ingest/src/main.rs`) opens one slot itself:
`org_clickhouse_settings.ch_password`. Both implementations are pinned to the same test
fixture (`secret-slots.test.ts` and the gateway's `secret_keyring_*` tests).

### Rolling out v3

Readers and writers deploy separately (the ingest gateway apart from the Workers), so v3 goes
out in three steps:

1. Every reader opens v2 and v3. Writers still seal v2, and the reseal pass counts a v3 value
   as current, so it does not turn step 2's values back into v2 while both run.
2. Once step 1 runs everywhere, the gateway included: writers seal v3 for destination slots,
   and the hourly reseal pass rewrites their v2 values as v3.
3. Once `secretsResealRemaining` is 0 on two passes: destination slots stop opening v2. Until
   this step a v2 value still opens wherever its row points, so the protection starts here.

## Keys

| Variable                           | Purpose                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `MAPLE_INGEST_KEY_ENCRYPTION_KEY`  | The primary master key. Seals every new value. Base64, 32 bytes.  |
| `MAPLE_INGEST_KEY_DECRYPTION_KEYS` | Optional, comma-separated. Master keys accepted for opening only. |

Every deployable that opens secrets reads both: the API, AI, alerting and chat-bot Workers and
the schema-apply workflow.

The ingest gateway does not receive the master keys. Its deploy derives the subkeys of the one
slot it opens (`packages/infra/src/secret-slot-keys.ts`, read through `resolveDerived` in
`@maple/infra/secret-guard`) and hands it only those:

| Variable                             | Purpose                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `MAPLE_INGEST_CH_PASSWORD_SLOT_KEYS` | `<keyId>:<base64 subkey>` per master key, comma-separated, primary first. Opens `org_clickhouse_settings.ch_password` only. |

The gateway prefers it and falls back to the two master-key variables when it is unset, which a
self-hosted or local deploy still sets. It refuses to start with neither. A key rotation needs no
gateway step of its own: each deploy derives the slot keys from the masters it loads.
`secret-slot-keys-parity.test.ts` holds the infra derivation equal to SecretBox's, and the
fixture master's slot keys are pinned there and in the gateway's tests.

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
rewrites every stored value whose ciphertext does not start with the primary key's prefix in
its slot's envelope (`v2.<primary key id>.`, or `v3.` for a slot with a destination): every
value sealed by a key that is no longer primary, and every v2 value of a destination slot. A
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

The same holds for the v3 envelope: a release that seals v3 but still opens v2 has to run
until `secretsResealRemaining` is 0 before one that refuses v2 for destination slots. Skipping
it leaves BYO ClickHouse passwords, scrape credentials, data source secrets and uptime headers
that no longer open, and they have to be entered again.
