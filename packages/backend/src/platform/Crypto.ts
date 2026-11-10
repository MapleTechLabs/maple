import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Effect, Option, Result } from "effect"

const IV_BYTES = 12
const TAG_BYTES = 16

export interface EncryptedValue {
	readonly ciphertext: string
	readonly iv: string
	readonly tag: string
}

/** `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`, trimmed and checked once with `Env`. */
export const ingestKeyLookupHmacKey = <E>(
	env: { readonly ingestKeyLookupHmacKey: Result.Result<string, string> },
	onError: (message: string) => E,
): Effect.Effect<string, E> =>
	Result.match(env.ingestKeyLookupHmacKey, {
		onSuccess: Effect.succeed,
		onFailure: (message) => Effect.fail(onError(message)),
	})

/**
 * AES-256-GCM, the primitive under `SecretBox`. Stored secrets go through `SecretBox`, which
 * picks the key and the AAD. `aad` is authenticated but not stored, so it binds a ciphertext to
 * the row it was written for: decryption only succeeds with the exact same bytes.
 */
export const encryptAes256Gcm = <E>(
	plaintext: string,
	encryptionKey: Buffer,
	onError: (message: string) => E,
	aad: Buffer,
) =>
	Effect.try({
		try: () => {
			const iv = randomBytes(IV_BYTES)
			const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv)
			cipher.setAAD(aad)
			const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])

			return {
				ciphertext: ciphertext.toString("base64"),
				iv: iv.toString("base64"),
				tag: cipher.getAuthTag().toString("base64"),
			} satisfies EncryptedValue
		},
		catch: (error) => onError(error instanceof Error ? error.message : "Encryption failed"),
	})

/** Counterpart to {@link encryptAes256Gcm}: `aad` must match the value used to encrypt. */
export const decryptAes256Gcm = <E>(
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
	onError: (message: string) => E,
	aad: Buffer,
) =>
	Effect.try({
		try: () => {
			const iv = Buffer.from(encrypted.iv, "base64")
			const tag = Buffer.from(encrypted.tag, "base64")
			// A shorter tag is still a valid GCM tag to the runtime, and far easier to forge.
			if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return Option.none()
			const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv)
			decipher.setAAD(aad)
			decipher.setAuthTag(tag)

			const plaintext = Buffer.concat([
				decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
				decipher.final(),
			])

			return Option.some(plaintext.toString("utf8"))
		},
		catch: () => onError("Decryption failed"),
	}).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(onError("Decryption failed")),
				onSome: (plaintext) => Effect.succeed(plaintext),
			}),
		),
	)
