# Secret encryption in Postgres

Credentials Maple holds for a customer (OAuth tokens, warehouse passwords, webhook secrets,
alert destination secrets, ...) are sealed with AES-256-GCM before they reach Postgres. The
code is `packages/backend/src/platform/SecretBox.ts`; the list of sealed columns is
`packages/backend/src/platform/secret-slots.ts`.

## Storage

Each secret is a `(ciphertext, iv, tag)` column triple, all base64.

| Envelope | `ciphertext` column   | Key                         | Bound to                     |
| -------- | --------------------- | --------------------------- | ---------------------------- |
| v2       | `v2.<keyId>.<base64>` | subkey derived for the slot | slot, org and row            |
| pre-v2   | `<base64>`            | master key                  | nothing, or a per-column AAD |

- **Slot**: one secret column, named `table.column`. The name is part of every ciphertext, so
  it never changes once rows exist.
- **Subkey**: `HKDF-SHA256(master, info = "maple/secret-box/v2/slot/<slot>")`. A value sealed
  for one column does not open as another.
- **Binding**: the AAD is the slot name plus the row's identity (`org_id`, then the id or the
  upsert conflict target), length-prefixed. A triple copied onto another row or org fails to
  open. Someone with database write access but no key therefore cannot point Maple at another
  org's credentials.
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

## Rollout state

Readers in every deployable open both envelopes. Writers still emit the pre-v2 envelope,
because the Workers and the gateway deploy separately and a reader must understand v2 before
any writer produces it.
