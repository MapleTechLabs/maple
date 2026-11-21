// Deploy-side derivation of SecretBox slot subkeys (docs/secret-encryption.md), so a deployable
// that opens one slot gets that slot's keys and never the master keys they come from.
// Mirrors `packages/backend/src/platform/SecretBox.ts`; a backend test pins the two together.
import { hkdfSync } from "node:crypto"
import { Array as Arr, Effect, Option, Redacted, Schema, String as Str } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

const SUBKEY_INFO_PREFIX = "maple/secret-box/v2/slot/"
const KEY_ID_INFO = "maple/secret-box/v2/key-id"

/** The slot the ingest gateway opens: BYO ClickHouse passwords. */
export const CLICKHOUSE_PASSWORD_SLOT = "org_clickhouse_settings.ch_password"

/** The env name the ingest task reads its ClickHouse password slot keys from. */
export const CH_PASSWORD_SLOT_KEYS_ENV = "MAPLE_INGEST_CH_PASSWORD_SLOT_KEYS"

/** A master key that is not base64 for 32 bytes. Carries no key material. */
export class SlotKeyDerivationError extends Schema.TaggedError<SlotKeyDerivationError>()(
	"@maple/infra/SlotKeyDerivationError",
	{ message: Schema.String },
) {}

/** HKDF-SHA256 with an empty salt, one 32-byte block: `hkdfSha256` in SecretBox.ts. */
const hkdf = (master: Buffer, info: string): Buffer =>
	Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32))

/** The fingerprint a v2/v3 envelope names its master key by. */
export const secretKeyId = (master: Buffer): string =>
	hkdf(master, KEY_ID_INFO).subarray(0, 6).toString("base64url")

/** The subkey a slot's values are sealed under for `master`. */
export const secretSlotSubkey = (master: Buffer, slot: string): Buffer =>
	hkdf(master, `${SUBKEY_INFO_PREFIX}${slot}`)

const parseMaster = (raw: string, envKey: string) => {
	const decoded = Buffer.from(Str.trim(raw), "base64")
	return decoded.length === 32
		? Effect.succeed(decoded)
		: Effect.fail(
				new SlotKeyDerivationError({ message: `${envKey} must be base64 for exactly 32 bytes` }),
			)
}

/**
 * A value derived from a secret, the only thing `resolveDerived` hands out. The class is not
 * exported and its private field makes the type nominal, so only this module mints one: a `derive`
 * that returns its input does not type-check, and `isDerivedSecret` refuses it at run time too.
 */
class Derived {
	readonly #minted = true
	constructor(readonly value: Redacted.Redacted) {}
	static is(value: unknown): value is Derived {
		return value instanceof Derived && value.#minted
	}
}

export type DerivedSecret = Derived

/** Whether `value` came out of this module's derivations, not out of the secret itself. */
export const isDerivedSecret = (value: unknown): value is DerivedSecret => Derived.is(value)

interface SlotKey {
	readonly id: string
	readonly subkey: string
}

export interface SlotKeyMasters {
	readonly primary: Redacted.Redacted
	/** Comma-separated decrypt-only keys, kept while a rotation is in flight. */
	readonly decryptOnly: Option.Option<Redacted.Redacted>
}

/**
 * `<keyId>:<base64 subkey>` per master, comma-joined, primary first and deduplicated by keyId.
 * Only the slot's subkeys leave this function; the masters do not.
 */
export const slotKeysFor = (slot: string, masters: SlotKeyMasters) =>
	Effect.gen(function* () {
		const primary = yield* parseMaster(Redacted.value(masters.primary), "MAPLE_INGEST_KEY_ENCRYPTION_KEY")
		const extraRaw = Arr.filter(
			Arr.map(
				Str.split(
					Option.match(masters.decryptOnly, { onNone: () => "", onSome: Redacted.value }),
					",",
				),
				Str.trim,
			),
			Str.isNonEmpty,
		)
		const extra = yield* Effect.forEach(extraRaw, (raw) =>
			parseMaster(raw, "MAPLE_INGEST_KEY_DECRYPTION_KEYS"),
		)
		const entries = Arr.dedupeWith(
			Arr.map([primary, ...extra], (master) => ({
				id: secretKeyId(master),
				subkey: secretSlotSubkey(master, slot).toString("base64"),
			})),
			(a: SlotKey, b: SlotKey) => a.id === b.id,
		)
		return new Derived(
			Redacted.make(
				Arr.join(
					Arr.map(entries, (entry) => `${entry.id}:${entry.subkey}`),
					",",
				),
				{ label: CH_PASSWORD_SLOT_KEYS_ENV },
			),
		)
	})

/** The ingest gateway's slot keys: only `org_clickhouse_settings.ch_password`. */
export const clickHousePasswordSlotKeys = (masters: SlotKeyMasters) =>
	slotKeysFor(CLICKHOUSE_PASSWORD_SLOT, masters)

/** The warehouse refused or did not return a scoped token. Carries no token material. */
export class ScopedTokenLookupError extends Schema.TaggedError<ScopedTokenLookupError>()(
	"@maple/infra/ScopedTokenLookupError",
	{ message: Schema.String, tokenName: Schema.String },
) {}

const TokenBody = Schema.Struct({ token: Schema.String })

/**
 * The value of the warehouse token `tokenName`, read with the workspace's admin token. The deploy
 * hands the scoped token on; the admin token stays in the deploy.
 */
export const warehouseTokenByName = (host: string, adminToken: Redacted.Redacted, tokenName: string) =>
	Effect.gen(function* () {
		const base = yield* HttpClient.HttpClient
		const client = HttpClient.filterStatusOk(base)
		const origin = Str.replace(/\/+$/, "")(Str.trim(host))
		const response = yield* client.execute(
			HttpClientRequest.get(`${origin}/v0/tokens/${encodeURIComponent(tokenName)}`).pipe(
				HttpClientRequest.bearerToken(adminToken),
			),
		)
		const body = yield* HttpClientResponse.schemaBodyJson(TokenBody)(response)
		const token = Str.trim(body.token)
		return Str.isNonEmpty(token)
			? new Derived(Redacted.make(token, { label: tokenName }))
			: yield* new ScopedTokenLookupError({ message: "the token came back empty", tokenName })
	}).pipe(
		Effect.catchTags({
			HttpClientError: (error) =>
				Effect.fail(
					new ScopedTokenLookupError({
						message: `the token lookup failed (${error.reason._tag}${error.response ? ` ${error.response.status}` : ""})`,
						tokenName,
					}),
				),
			SchemaError: () =>
				Effect.fail(
					new ScopedTokenLookupError({
						message: "the token lookup answered an unexpected shape",
						tokenName,
					}),
				),
		}),
	)
