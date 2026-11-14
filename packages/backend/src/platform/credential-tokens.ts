/**
 * Every bearer credential Maple mints: its prefix, how it is generated, and the keyed digest it is
 * looked up by. Minting and parsing read the same prefixes, so they cannot drift apart.
 */
import { createHmac, randomBytes } from "node:crypto"
import { Result, String as Str } from "effect"

/** Lookup digest for a random token, not a human-chosen password. */
const hmacDigest = (raw: string, hmacKey: string): string =>
	createHmac("sha256", hmacKey).update(raw, "utf8").digest("base64url")

export const API_KEY_PREFIX = "maple_ak_"

export const generateApiKey = (): string => `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`

export const hashApiKey = (rawKey: string, hmacKey: string): string => hmacDigest(rawKey, hmacKey)

export const PUBLIC_INGEST_KEY_PREFIX = "maple_pk_"
export const PRIVATE_INGEST_KEY_PREFIX = "maple_sk_"

export type IngestKeyType = "public" | "private"

export interface ResolvedIngestKey {
	readonly orgId: string
	readonly keyType: IngestKeyType
	readonly keyId: string
}

export const generatePublicIngestKey = (): string =>
	`${PUBLIC_INGEST_KEY_PREFIX}${randomBytes(24).toString("base64url")}`

export const generatePrivateIngestKey = (): string =>
	`${PRIVATE_INGEST_KEY_PREFIX}${randomBytes(24).toString("base64url")}`

export const inferIngestKeyType = (rawKey: string): IngestKeyType | null => {
	if (Str.startsWith(PUBLIC_INGEST_KEY_PREFIX)(rawKey)) return "public"
	if (Str.startsWith(PRIVATE_INGEST_KEY_PREFIX)(rawKey)) return "private"
	return null
}

/** The lookup HMAC key, trimmed, or why it is unusable. */
export const ingestKeyLookupHmacKeyFrom = (raw: string): Result.Result<string, string> => {
	const trimmed = Str.trim(raw)
	return trimmed.length === 0
		? Result.fail("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY is required")
		: Result.succeed(trimmed)
}

export const hashIngestKey = (rawKey: string, hmacKey: string): string => hmacDigest(rawKey, hmacKey)

export const createIngestKeyId = (hash: string): string => Str.slice(0, 16)(hash)

// Fixed input for the startup HMAC fingerprint emitted by the API and ingest
// gateway. Operators diff the resulting 8-char prefix between the two services
// to detect env-var drift on `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`. Must stay
// byte-identical with the Rust constant in `apps/ingest/src/main.rs`.
export const HMAC_FINGERPRINT_SENTINEL = "MAPLE_HMAC_FINGERPRINT_V1"

export const computeHmacFingerprint = (hmacKey: string): string =>
	Str.slice(0, 8)(hashIngestKey(HMAC_FINGERPRINT_SENTINEL, hmacKey))

const SHARE_TOKEN_PREFIX = "mshare_"

/**
 * Number of trailing characters kept in plaintext, so a link can be named in a
 * list or an audit trail ("…a1b2c3") without decrypting the stored token.
 */
const SHARE_TOKEN_SUFFIX_LENGTH = 6

export const generateShareToken = (): string =>
	`${SHARE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`

/**
 * Keyed HMAC rather than a bare digest, matching `hashApiKey`: the token is the
 * only credential a public share link carries, so a database dump on its own
 * must not be a set of working links. The recoverable copy alongside it is
 * encrypted under a key held outside Postgres, which keeps that true.
 *
 * Deterministic, which is what makes the lookup a single indexed equality on
 * `token_hash`: there is no candidate row to compare against in variable time,
 * so this path needs no constant-time compare.
 */
export const hashShareToken = (rawToken: string, hmacKey: string): string => hmacDigest(rawToken, hmacKey)

export const shareTokenSuffix = (rawToken: string): string => Str.slice(-SHARE_TOKEN_SUFFIX_LENGTH)(rawToken)
