// BOUNDARY-FILE: This module owns unparsed external values and narrows them before domain use.
/**
 * Pub/Sub push authentication for Security Command Center notifications, the API's twin of the
 * ingest gateway's `gcp_push_auth.rs`. The subscription signs each push as the connector's push
 * service account: `Authorization: Bearer <ID token>`, signed by Google, naming that account
 * (`email`) and the endpoint it was given (`aud`). Only someone who may act as the account can
 * make Pub/Sub sign as it, so the token stands in for a secret in the push URL.
 */
import { gcpConnectorResourceNames, gcpServiceAccountEmail } from "@maple/domain/gcp"
import type { GcpConnectorId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Ref, Schema, String as Str } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { fromBase64url, RS256 } from "@maple/backend/platform/jwt"

export const GCP_SECURITY_PUSH_ROUTE = "/api/integrations/gcp/security/:connectorId"

/** Where a connector's SCC notifications are pushed: the tokens' audience, so derived, never stored. */
export const gcpSecurityPushEndpoint = (apiBaseUrl: string, connectorId: GcpConnectorId): string =>
	`${Str.replace(/\/+$/, "")(apiBaseUrl)}/api/integrations/gcp/security/${connectorId}`

/** The account a connector's subscription signs as. */
export const gcpPushServiceAccount = (connector: {
	readonly id: GcpConnectorId
	readonly projectId: string
}): string =>
	gcpServiceAccountEmail(gcpConnectorResourceNames(connector.id).pushServiceAccountId, connector.projectId)

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]
/** Tolerated difference between Google's clock and this one. */
const CLOCK_SKEW_SECONDS = 60
/** Google publishes a key hours before it signs with it: an hour keeps rotation far inside that. */
const KEYS_TTL_MS = 60 * 60 * 1000
/** A token naming a key not in hand fetches the keys again at most this often. */
const REFETCH_INTERVAL_MS = 60 * 1000

export const PushTokenRejection = Schema.Literals([
	"malformed",
	"unknown_key",
	"bad_signature",
	"wrong_issuer",
	"wrong_audience",
	"wrong_account",
	"expired",
	"keys_unavailable",
])
export type PushTokenRejection = typeof PushTokenRejection.Type

export class PushTokenRejected extends Schema.TaggedError<PushTokenRejected>()(
	"@maple/backend/gcp/PushTokenRejected",
	{ message: Schema.String, reason: PushTokenRejection },
) {}

const reject = (reason: PushTokenRejection) =>
	new PushTokenRejected({ message: `Push token refused: ${reason}`, reason })

const Jwk = Schema.Struct({
	kid: Schema.String,
	kty: Schema.Literal("RSA"),
	n: Schema.String,
	e: Schema.String,
})
type Jwk = typeof Jwk.Type
const JwkSet = Schema.Struct({ keys: Schema.Array(Schema.Unknown) })
const decodeJwk = Schema.decodeUnknownOption(Jwk)

const Header = Schema.Struct({ alg: Schema.Literal("RS256"), kid: Schema.String })
const Claims = Schema.Struct({
	iss: Schema.String,
	aud: Schema.String,
	email: Schema.String,
	email_verified: Schema.optionalKey(Schema.Boolean),
	exp: Schema.Finite,
	iat: Schema.Finite,
})
const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header))
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims))

/** Google's signing keys by key id. */
export type GoogleKeys = ReadonlyMap<string, Jwk>

export const googleKeysOf = (body: unknown): GoogleKeys =>
	new Map(
		Arr.flatMap(Option.toArray(Schema.decodeUnknownOption(JwkSet)(body)), (set) =>
			Arr.flatMap(set.keys, (key) =>
				Option.toArray(Option.map(decodeJwk(key), (jwk) => [jwk.kid, jwk] as const)),
			),
		),
	)

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

export interface ExpectedPush {
	readonly audience: string
	/** The signing account, when the caller knows it already; absent, the caller checks the returned one. */
	readonly email?: string | undefined
}

/** What a valid token says: who signed it, for which endpoint. */
export interface VerifiedPush {
	readonly email: string
	readonly audience: string
}

/**
 * Checks one token against Google's keys: signature, issuer, the endpoint (and the account when
 * given), and its lifetime. The key lookup is the caller's, so a test can hand in its own keys.
 */
export const verifyGooglePushToken = Effect.fn("GcpSecurityPush.verifyToken")(function* (
	token: string,
	keys: GoogleKeys,
	expected: ExpectedPush,
	nowMs: number,
) {
	const parts = Str.split(".")(token)
	const [rawHeader, rawClaims, rawSignature] = parts
	if (
		parts.length !== 3 ||
		rawHeader === undefined ||
		rawClaims === undefined ||
		rawSignature === undefined
	)
		return yield* reject("malformed")
	const header = decodeHeader(utf8(fromBase64url(rawHeader)))
	const claims = decodeClaims(utf8(fromBase64url(rawClaims)))
	if (Option.isNone(header) || Option.isNone(claims)) return yield* reject("malformed")
	const jwk = keys.get(header.value.kid)
	if (jwk === undefined) return yield* reject("unknown_key")
	const valid = yield* Effect.tryPromise({
		try: async () => {
			const key = await crypto.subtle.importKey(
				"jwk",
				{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
				RS256,
				false,
				["verify"],
			)
			return crypto.subtle.verify(
				RS256,
				key,
				new Uint8Array(fromBase64url(rawSignature)),
				new TextEncoder().encode(`${rawHeader}.${rawClaims}`),
			)
		},
		catch: () => reject("bad_signature"),
	})
	if (!valid) return yield* reject("bad_signature")
	const { iss, aud, email, email_verified, exp, iat } = claims.value
	if (!Arr.contains(GOOGLE_ISSUERS, iss)) return yield* reject("wrong_issuer")
	if (aud !== expected.audience) return yield* reject("wrong_audience")
	if (email_verified === false || (expected.email !== undefined && email !== expected.email))
		return yield* reject("wrong_account")
	const now = Math.floor(nowMs / 1000)
	if (exp + CLOCK_SKEW_SECONDS < now || iat - CLOCK_SKEW_SECONDS > now) return yield* reject("expired")
	return { email, audience: aud } satisfies VerifiedPush
})

export interface GooglePushTokensApi {
	/**
	 * Verifies a push token against Google's current keys and the endpoint it must name. Checked
	 * before any lookup, so a forged push costs no database read.
	 */
	readonly verify: (token: string, expected: ExpectedPush) => Effect.Effect<VerifiedPush, PushTokenRejected>
}

interface KeyCache {
	readonly keys: GoogleKeys
	/** When the keys were fetched; they are refreshed an hour later. */
	readonly fetchedAt: number
	/** The last fetch attempt, kept or not: fetches are at least a minute apart, even while Google fails. */
	readonly attemptedAt: number
}

export class GooglePushTokens extends Context.Service<GooglePushTokens, GooglePushTokensApi>()(
	"@maple/backend/services/GooglePushTokens",
	{
		make: Effect.gen(function* () {
			const httpClient = yield* HttpClient.HttpClient
			// Per isolate: a fresh Worker fetches once, then every push reuses the keys for an hour.
			const cache = yield* Ref.make<KeyCache>({ keys: new Map(), fetchedAt: 0, attemptedAt: 0 })

			/** Fresh keys, or the ones in hand when Google cannot be reached: they stay valid for hours. */
			const refresh = Effect.fn("GooglePushTokens.refresh")(function* (now: number) {
				const cached = yield* Ref.get(cache)
				if (now - cached.attemptedAt < REFETCH_INTERVAL_MS) return cached.keys
				yield* Ref.set(cache, { ...cached, attemptedAt: now })
				const fetched = yield* httpClient.get(GOOGLE_CERTS_URL).pipe(
					Effect.flatMap(HttpClientResponse.filterStatusOk),
					Effect.flatMap((response) => response.json),
					Effect.map(googleKeysOf),
					Effect.timeout("10 seconds"),
					Effect.option,
				)
				if (Option.isNone(fetched) || fetched.value.size === 0) {
					yield* Effect.annotateCurrentSpan("maple.gcp_security.keys_unavailable", true)
					return cached.keys
				}
				yield* Ref.set(cache, { keys: fetched.value, fetchedAt: now, attemptedAt: now })
				return fetched.value
			})

			const verify = Effect.fn("GooglePushTokens.verify")(function* (
				token: string,
				expected: ExpectedPush,
			) {
				const now = yield* Clock.currentTimeMillis
				const cached = yield* Ref.get(cache)
				const keys = now - cached.fetchedAt > KEYS_TTL_MS ? yield* refresh(now) : cached.keys
				if (keys.size === 0) return yield* reject("keys_unavailable")
				const first = yield* Effect.result(verifyGooglePushToken(token, keys, expected, now))
				if (first._tag === "Success") return first.success
				// A key Google rotated in since the last fetch; `refresh` keeps made-up key ids from forcing fetches.
				if (first.failure.reason === "unknown_key") {
					const fresh = yield* refresh(now)
					return yield* verifyGooglePushToken(token, fresh, expected, now)
				}
				return yield* first.failure
			})

			return { verify } satisfies GooglePushTokensApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
