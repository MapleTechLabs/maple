import { createHmac } from "node:crypto"
import { Effect, String as Str } from "effect"

export type IngestKeyType = "public" | "private"

export interface ResolvedIngestKey {
	readonly orgId: string
	readonly keyType: IngestKeyType
	readonly keyId: string
}

export const inferIngestKeyType = (rawKey: string): IngestKeyType | null => {
	if (Str.startsWith("maple_pk_")(rawKey)) return "public"
	if (Str.startsWith("maple_sk_")(rawKey)) return "private"
	return null
}

export const parseIngestKeyLookupHmacKey = <E>(
	raw: string,
	onError: (message: string) => E,
): Effect.Effect<string, E> =>
	Effect.suspend(() => {
		const trimmed = Str.trim(raw)
		return trimmed.length === 0
			? Effect.fail(onError("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY is required"))
			: Effect.succeed(trimmed)
	})

export const hashIngestKey = (rawKey: string, hmacKey: string): string =>
	createHmac("sha256", hmacKey).update(rawKey, "utf8").digest("base64url")

export const createIngestKeyId = (hash: string): string => Str.slice(0, 16)(hash)

// Fixed input for the startup HMAC fingerprint emitted by the API and ingest
// gateway. Operators diff the resulting 8-char prefix between the two services
// to detect env-var drift on `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`. Must stay
// byte-identical with the Rust constant in `apps/ingest/src/main.rs`.
export const HMAC_FINGERPRINT_SENTINEL = "MAPLE_HMAC_FINGERPRINT_V1"

export const computeHmacFingerprint = (hmacKey: string): string =>
	Str.slice(0, 8)(hashIngestKey(HMAC_FINGERPRINT_SENTINEL, hmacKey))
