/**
 * Sealing for secrets stored in Postgres.
 *
 * A sealed value lives in a `(ciphertext, iv, tag)` column triple. The v2 envelope keeps that
 * shape and prefixes the ciphertext: `v2.<keyId>.<base64>`. It is encrypted under a subkey
 * derived for its slot (`table.column`) and authenticated against the slot and the row it
 * belongs to, so a triple copied onto another row, column or org does not open. `keyId` names
 * the master key that sealed it, which is what makes rotation possible (docs/secret-encryption.md).
 *
 * A ciphertext without that prefix is not opened: an unbound value from before v2 could
 * otherwise be replayed onto another row.
 */
import { createHmac } from "node:crypto"
import { Array as Arr, Effect, Option, Redacted, String as Str } from "effect"
import { decryptAes256Gcm, encryptAes256Gcm, type EncryptedValue } from "./Crypto"

const ENVELOPE_PREFIX = "v2"
const SUBKEY_INFO_PREFIX = "maple/secret-box/v2/slot/"
const KEY_ID_INFO = "maple/secret-box/v2/key-id"

interface SecretKey {
	/** Fingerprint of the master key: safe to store, useless for decrypting. */
	readonly id: string
	readonly master: Buffer
}

export interface SecretKeyring {
	/** Seals every new value. */
	readonly primary: SecretKey
	/** `primary` first, then the keys accepted for opening only. */
	readonly keys: Arr.NonEmptyReadonlyArray<SecretKey>
}

/**
 * One secret column. `name` is `table.column` and is part of every ciphertext (subkey label and
 * first AAD part), so it never changes once rows exist. `binding` is the row's identity: the org
 * plus whatever makes the row unique and survives an upsert.
 */
export interface SecretSlot<Ref> {
	readonly name: string
	readonly binding: (ref: Ref) => ReadonlyArray<string>
}

/** HKDF-SHA256 (RFC 5869) with an empty salt: the first 32-byte output block. */
export const hkdfSha256 = (inputKey: Buffer, info: string): Buffer => {
	const pseudoRandomKey = createHmac("sha256", Buffer.alloc(32)).update(inputKey).digest()
	return createHmac("sha256", pseudoRandomKey)
		.update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([1])]))
		.digest()
}

const makeSecretKey = (master: Buffer): SecretKey => ({
	id: hkdfSha256(master, KEY_ID_INFO).subarray(0, 6).toString("base64url"),
	master,
})

const subkeyFor = (key: SecretKey, slotName: string): Buffer =>
	hkdfSha256(key.master, `${SUBKEY_INFO_PREFIX}${slotName}`)

/** Length-prefixed parts, so no two different (slot, row) pairs produce the same bytes. */
const secretAad = (slotName: string, binding: ReadonlyArray<string>): Buffer =>
	Buffer.from(
		Arr.join(
			Arr.map([slotName, ...binding], (part) => `${Buffer.byteLength(part, "utf8")}:${part},`),
			"",
		),
		"utf8",
	)

const parseKey = (raw: string): Option.Option<Buffer> => {
	const decoded = Buffer.from(Str.trim(raw), "base64")
	return decoded.length === 32 ? Option.some(decoded) : Option.none()
}

export const PRIMARY_KEY_ENV = "MAPLE_INGEST_KEY_ENCRYPTION_KEY"
export const DECRYPTION_KEYS_ENV = "MAPLE_INGEST_KEY_DECRYPTION_KEYS"

/**
 * Builds the keyring from the raw settings: one primary key, plus an optional comma-separated
 * list of keys kept only for opening values sealed before a rotation.
 */
export const parseSecretKeyring = <E>(
	raw: { readonly primary: string; readonly decryptOnly: Option.Option<string> },
	onError: (message: string) => E,
): Effect.Effect<SecretKeyring, E> =>
	Effect.suspend((): Effect.Effect<SecretKeyring, E> => {
		if (Str.trim(raw.primary).length === 0) {
			return Effect.fail(onError(`${PRIMARY_KEY_ENV} is required`))
		}
		const primary = parseKey(raw.primary)
		if (Option.isNone(primary)) {
			return Effect.fail(onError(`${PRIMARY_KEY_ENV} must be base64 for exactly 32 bytes`))
		}
		const extraRaw = Arr.filter(
			Arr.map(
				Str.split(
					Option.getOrElse(raw.decryptOnly, () => ""),
					",",
				),
				Str.trim,
			),
			Str.isNonEmpty,
		)
		const extra = Arr.map(extraRaw, parseKey)
		if (Arr.some(extra, Option.isNone)) {
			return Effect.fail(
				onError(`${DECRYPTION_KEYS_ENV} must be comma-separated base64 keys of exactly 32 bytes`),
			)
		}
		const primaryKey = makeSecretKey(primary.value)
		const extraKeys = Arr.filter(
			Arr.dedupeWith(
				Arr.map(Arr.getSomes(extra), makeSecretKey),
				(a: SecretKey, b: SecretKey) => a.id === b.id,
			),
			(key) => key.id !== primaryKey.id,
		)
		return Effect.succeed({ primary: primaryKey, keys: [primaryKey, ...extraKeys] })
	})

export interface SecretKeyringEnv {
	readonly MAPLE_INGEST_KEY_ENCRYPTION_KEY: Redacted.Redacted
	readonly MAPLE_INGEST_KEY_DECRYPTION_KEYS: Option.Option<Redacted.Redacted>
}

export const secretKeyringFromEnv = <E>(
	env: SecretKeyringEnv,
	onError: (message: string) => E,
): Effect.Effect<SecretKeyring, E> =>
	parseSecretKeyring(
		{
			primary: Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			decryptOnly: Option.map(env.MAPLE_INGEST_KEY_DECRYPTION_KEYS, Redacted.value),
		},
		onError,
	)

interface Envelope {
	readonly keyId: string
	readonly ciphertext: string
}

const parseEnvelope = (stored: string): Option.Option<Envelope> => {
	const parts = Str.split(stored, ".")
	const [prefix, keyId, ciphertext] = parts
	return parts.length === 3 && prefix === ENVELOPE_PREFIX && keyId !== undefined && ciphertext !== undefined
		? Option.some({ keyId, ciphertext })
		: Option.none()
}

/** What every ciphertext sealed by the primary key starts with. */
export const currentEnvelopePrefix = (keyring: SecretKeyring): string =>
	`${ENVELOPE_PREFIX}.${keyring.primary.id}.`

/** Seals a value for `slot` on the row `ref` names: slot subkey, row-bound, key id recorded. */
export const sealSecret = <Ref, E>(
	keyring: SecretKeyring,
	slot: SecretSlot<Ref>,
	ref: Ref,
	plaintext: string,
	onError: (message: string) => E,
): Effect.Effect<EncryptedValue, E> =>
	encryptAes256Gcm(
		plaintext,
		subkeyFor(keyring.primary, slot.name),
		onError,
		secretAad(slot.name, slot.binding(ref)),
	).pipe(
		Effect.map((sealed) => ({
			...sealed,
			ciphertext: `${currentEnvelopePrefix(keyring)}${sealed.ciphertext}`,
		})),
	)

/** Opens a stored value. Fails when the key, the slot or the row no longer match. */
export const openSecret = <Ref, E>(
	keyring: SecretKeyring,
	slot: SecretSlot<Ref>,
	ref: Ref,
	stored: EncryptedValue,
	onError: (message: string) => E,
): Effect.Effect<string, E> =>
	Option.match(parseEnvelope(stored.ciphertext), {
		onNone: () => Effect.fail(onError("Stored value is not in the v2 envelope")),
		onSome: (envelope) =>
			Option.match(
				Arr.findFirst(keyring.keys, (key) => key.id === envelope.keyId),
				{
					onNone: () => Effect.fail(onError("Sealed with a key this deployment does not hold")),
					onSome: (key) =>
						decryptAes256Gcm(
							{ ciphertext: envelope.ciphertext, iv: stored.iv, tag: stored.tag },
							subkeyFor(key, slot.name),
							onError,
							secretAad(slot.name, slot.binding(ref)),
						),
				},
			),
	})
