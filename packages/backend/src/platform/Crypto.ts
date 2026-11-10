import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Effect, Result, String as Str } from "effect"

export interface EncryptedValue {
	readonly ciphertext: string
	readonly iv: string
	readonly tag: string
}

/** A base64 AES-256-GCM key, or why it is unusable. */
export const aes256GcmKeyFromBase64 = (raw: string): Result.Result<Buffer, string> => {
	const trimmed = Str.trim(raw)
	if (trimmed.length === 0) return Result.fail("Expected a non-empty base64 encryption key")
	const decoded = Buffer.from(trimmed, "base64")
	if (decoded.length !== 32) return Result.fail("Expected base64 for exactly 32 bytes")
	return Result.succeed(decoded)
}

export const parseBase64Aes256GcmKey = <E>(raw: string, onError: (message: string) => E) =>
	Effect.suspend(() => keyOrFail(aes256GcmKeyFromBase64(raw), onError))

const keyOrFail = <A, E>(
	key: Result.Result<A, string>,
	onError: (message: string) => E,
): Effect.Effect<A, E> =>
	Result.match(key, { onSuccess: Effect.succeed, onFailure: (message) => Effect.fail(onError(message)) })

/** A bad ingest encryption key's problem, naming the variable to fix. */
export const ingestKeyEncryptionProblem = (message: string): string =>
	message === "Expected a non-empty base64 encryption key"
		? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
		: message === "Expected base64 for exactly 32 bytes"
			? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
			: message

/** `MAPLE_INGEST_KEY_ENCRYPTION_KEY`, parsed once with `Env`; `onError` names a bad key in the caller's terms. */
export const ingestKeyEncryptionKey = <E>(
	env: { readonly ingestKeyEncryptionKey: Result.Result<Buffer, string> },
	onError: (message: string) => E,
): Effect.Effect<Buffer, E> => keyOrFail(env.ingestKeyEncryptionKey, onError)

/** `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`, trimmed and checked once with `Env`. */
export const ingestKeyLookupHmacKey = <E>(
	env: { readonly ingestKeyLookupHmacKey: Result.Result<string, string> },
	onError: (message: string) => E,
): Effect.Effect<string, E> => keyOrFail(env.ingestKeyLookupHmacKey, onError)

/**
 * Optional additional authenticated data. AAD is authenticated but not stored,
 * so it binds a ciphertext to the row it was written for: decryption only
 * succeeds when the caller reconstructs the exact same bytes. Omitting it keeps
 * the original (AAD-free) format — existing ciphertexts written without one must
 * keep decrypting, so callers may only start passing an `aad` for columns with
 * no live rows.
 */
export const encryptAes256Gcm = <E>(
	plaintext: string,
	encryptionKey: Buffer,
	onError: (message: string) => E,
	aad?: Buffer,
) =>
	Effect.try({
		try: () => {
			const iv = randomBytes(12)
			const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv)
			if (aad !== undefined) cipher.setAAD(aad)
			const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])

			return {
				ciphertext: ciphertext.toString("base64"),
				iv: iv.toString("base64"),
				tag: cipher.getAuthTag().toString("base64"),
			} satisfies EncryptedValue
		},
		catch: (error) => onError(error instanceof Error ? error.message : "Encryption failed"),
	})

/** Counterpart to {@link encryptAes256Gcm} — `aad` must match the value used to encrypt. */
export const decryptAes256Gcm = <E>(
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
	onError: (message: string) => E,
	aad?: Buffer,
) =>
	Effect.try({
		try: () => {
			const decipher = createDecipheriv(
				"aes-256-gcm",
				encryptionKey,
				Buffer.from(encrypted.iv, "base64"),
			)
			if (aad !== undefined) decipher.setAAD(aad)
			decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"))

			const plaintext = Buffer.concat([
				decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
				decipher.final(),
			])

			return plaintext.toString("utf8")
		},
		catch: () => onError("Decryption failed"),
	})
