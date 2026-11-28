import { assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect, Result, String as Str } from "effect"
import { base64url } from "@maple/backend/platform/jwt"
import { type GoogleKeys, googleKeysOf, verifyGooglePushToken } from "./security-push"

const ENDPOINT = "https://api.maple.test/api/integrations/gcp/security/0d3c6f1e-6b8f-4e6b-9a1e-2f4c5d6e7f80"
const ACCOUNT = "maple-push-0d3c6f1e6b8f4e6b9a1@acme-prod.iam.gserviceaccount.com"
const NOW_MS = Date.UTC(2026, 10, 28, 12, 0, 0)
const NOW = NOW_MS / 1000

const RSA = {
	name: "RSASSA-PKCS1-v1_5",
	modulusLength: 2048,
	publicExponent: new Uint8Array([1, 0, 1]),
	hash: "SHA-256",
}

let signingKey: CryptoKey
let otherKey: CryptoKey
let keys: GoogleKeys

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])
	const other = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])
	signingKey = pair.privateKey
	otherKey = other.privateKey
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
	// Google's certs endpoint answers a JWK set; entries that are not RSA keys are skipped.
	keys = googleKeysOf({
		keys: [
			{ ...jwk, kid: "google-1", alg: "RS256", use: "sig" },
			{ kty: "EC", kid: "x" },
		],
	})
})

const sign = async (
	claims: Record<string, unknown>,
	options: { readonly kid?: string; readonly key?: CryptoKey } = {},
) => {
	const header = base64url(JSON.stringify({ alg: "RS256", kid: options.kid ?? "google-1", typ: "JWT" }))
	const payload = base64url(JSON.stringify(claims))
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		options.key ?? signingKey,
		new TextEncoder().encode(`${header}.${payload}`),
	)
	return `${header}.${payload}.${base64url(signature)}`
}

const claims = (overrides: Record<string, unknown> = {}) => ({
	iss: "https://accounts.google.com",
	aud: ENDPOINT,
	email: ACCOUNT,
	email_verified: true,
	iat: NOW - 10,
	exp: NOW + 3590,
	...overrides,
})

const reasonOf = (token: string) =>
	Effect.map(
		Effect.result(verifyGooglePushToken(token, keys, { audience: ENDPOINT, email: ACCOUNT }, NOW_MS)),
		(result) => (Result.isSuccess(result) ? "accepted" : result.failure.reason),
	)

describe("verifyGooglePushToken", () => {
	it.effect("accepts the connector's subscription signing for its endpoint", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* reasonOf(yield* Effect.promise(() => sign(claims()))), "accepted")
		}),
	)

	it.effect("refuses a token for another endpoint, another account, or past its lifetime", () =>
		Effect.gen(function* () {
			const reasons = yield* Effect.forEach(
				[
					claims({ aud: `${ENDPOINT}x` }),
					claims({ email: "attacker@evil.iam.gserviceaccount.com" }),
					claims({ email_verified: false }),
					claims({ iss: "https://evil.example" }),
					claims({ exp: NOW - 120, iat: NOW - 3720 }),
				],
				(body) =>
					Effect.flatMap(
						Effect.promise(() => sign(body)),
						reasonOf,
					),
			)
			assert.deepStrictEqual(reasons, [
				"wrong_audience",
				"wrong_account",
				"wrong_account",
				"wrong_issuer",
				"expired",
			])
		}),
	)

	it.effect("refuses a forged signature, an unknown key id, a tampered payload and garbage", () =>
		Effect.gen(function* () {
			const forged = yield* Effect.promise(() => sign(claims(), { key: otherKey }))
			const unknownKid = yield* Effect.promise(() => sign(claims(), { kid: "rotated-in" }))
			const good = yield* Effect.promise(() => sign(claims()))
			const [header, , signature] = Str.split(".")(good)
			const swapped = base64url(JSON.stringify(claims({ email: "x@y.iam.gserviceaccount.com" })))
			const tampered = `${header}.${swapped}.${signature}`
			assert.deepStrictEqual(
				yield* Effect.forEach([forged, unknownKid, tampered, "not.a.jwt", "abc"], reasonOf),
				["bad_signature", "unknown_key", "bad_signature", "malformed", "malformed"],
			)
		}),
	)
})
