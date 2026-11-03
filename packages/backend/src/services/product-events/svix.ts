import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"

/**
 * Svix (Standard Webhooks) signature verification, shared by the Clerk and
 * Autumn receivers — both deliver through Svix.
 *
 * Scheme: `svix-signature` carries space-separated `v1,<base64>` entries (one
 * per active secret during rotation). Each is HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}` keyed with the base64-decoded
 * secret after the `whsec_` prefix. `svix-timestamp` is Unix seconds and is
 * rejected outside a ±5 minute window so a captured delivery cannot be replayed.
 *
 * WebCrypto only — no `svix` dependency, and `crypto.subtle` is present on
 * Workers, Node ≥ 19 and vitest alike.
 */

export const SVIX_TOLERANCE_SECONDS = 5 * 60

export class SvixVerificationError extends Schema.TaggedError<SvixVerificationError>()(
	"@maple/backend/services/product-events/SvixVerificationError",
	{
		message: Schema.String,
		reason: Schema.Literals([
			"missing_headers",
			"bad_timestamp",
			"stale_timestamp",
			"bad_secret",
			"signature_mismatch",
		]),
	},
) {}

export interface SvixHeaders {
	readonly id: string | undefined
	readonly timestamp: string | undefined
	readonly signature: string | undefined
}

export const readSvixHeaders = (headers: Readonly<Record<string, string | undefined>>): SvixHeaders => ({
	id: headers["svix-id"],
	timestamp: headers["svix-timestamp"],
	signature: headers["svix-signature"],
})

const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> | undefined =>
	Option.liftThrowable(atob)(value).pipe(
		Option.map((binary) => {
			const bytes = new Uint8Array(new ArrayBuffer(binary.length))
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
			return bytes
		}),
		Option.getOrUndefined,
	)

const encodeBase64 = (bytes: ArrayBuffer): string => {
	let binary = ""
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
	return btoa(binary)
}

const constantTimeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

const secretBytes = (secret: string): Uint8Array<ArrayBuffer> | undefined => {
	const raw = Str.startsWith("whsec_")(secret) ? Str.slice("whsec_".length)(secret) : secret
	const bytes = decodeBase64(Str.trim(raw))
	return bytes === undefined || bytes.length === 0 ? undefined : bytes
}

/** Exported for tests and for anyone needing to sign a payload the Svix way. */
export const signSvix = (secret: string, id: string, timestamp: string, body: string) =>
	Effect.gen(function* () {
		const keyBytes = secretBytes(secret)
		if (keyBytes === undefined) {
			return yield* new SvixVerificationError({
				message: "Webhook secret is not valid base64",
				reason: "bad_secret",
			})
		}
		const key = yield* Effect.promise(() =>
			crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
		)
		const mac = yield* Effect.promise(() =>
			crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
		)
		return encodeBase64(mac)
	})

export const verifySvixSignature = (options: {
	readonly secret: string
	readonly headers: SvixHeaders
	readonly body: string
	readonly nowMs: number
	readonly toleranceSeconds?: number | undefined
}): Effect.Effect<void, SvixVerificationError> =>
	Effect.gen(function* () {
		const { id, timestamp, signature } = options.headers
		if (!id || !timestamp || !signature) {
			return yield* new SvixVerificationError({
				message: "Missing svix headers",
				reason: "missing_headers",
			})
		}
		const ts = Number(timestamp)
		if (!Number.isInteger(ts) || ts <= 0) {
			return yield* new SvixVerificationError({
				message: "Malformed svix-timestamp",
				reason: "bad_timestamp",
			})
		}
		const tolerance = options.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS
		if (Math.abs(Math.floor(options.nowMs / 1000) - ts) > tolerance) {
			return yield* new SvixVerificationError({
				message: "svix-timestamp outside tolerance",
				reason: "stale_timestamp",
			})
		}
		const expected = yield* signSvix(options.secret, id, timestamp, options.body)
		const provided = Arr.map(
			Arr.filter(
				Arr.map(Str.split(" ")(signature), (entry) => Str.trim(entry)),
				(entry) => Str.startsWith("v1,")(entry),
			),
			(entry) => Str.slice(3)(entry),
		)
		if (!Arr.some(provided, (candidate) => constantTimeEqual(candidate, expected))) {
			return yield* new SvixVerificationError({
				message: "Signature mismatch",
				reason: "signature_mismatch",
			})
		}
	})
