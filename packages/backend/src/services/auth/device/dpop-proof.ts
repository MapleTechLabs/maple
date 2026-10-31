/**
 * RFC 9449 section 4.3 proof checks, minus replay: that needs storage, so the caller records
 * the returned `jti` (see `DeviceCredentialsService`). Pure apart from WebCrypto.
 */
import { Effect, Option, Schema } from "effect"
import {
	base64url,
	EcPublicJwk,
	importEcPublicJwk,
	JoseError,
	jwkThumbprint,
	parseCompactJws,
	sha256,
	verifyEs256,
} from "./jose"

/** How far a proof's `iat` may sit from the server clock, either way. */
export const DPOP_MAX_SKEW_SECONDS = 60

export class DpopProofRejected extends Schema.TaggedError<DpopProofRejected>()(
	"@maple/backend/auth/device/DpopProofRejected",
	{
		message: Schema.String,
		/** `malformed`, `header`, `signature`, `htm`, `htu`, `iat`, `ath`, `replay`, `key`. */
		reason: Schema.String,
	},
) {}

const ProofHeader = Schema.Struct({
	typ: Schema.Literal("dpop+jwt"),
	alg: Schema.Literal("ES256"),
	jwk: Schema.Record(Schema.String, Schema.Unknown),
})

const ProofPayload = Schema.Struct({
	jti: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(256)),
	htm: Schema.String,
	htu: Schema.String,
	iat: Schema.Number.check(Schema.isInt()),
	ath: Schema.optionalKey(Schema.String),
})

const decodeHeader = Schema.decodeUnknownOption(ProofHeader)
const decodePayload = Schema.decodeUnknownOption(ProofPayload)
const decodeJwk = Schema.decodeUnknownOption(EcPublicJwk)

export interface DpopProofCheck {
	readonly proof: string
	readonly method: string
	/** The absolute request URL; query and fragment are ignored (RFC 9449 section 4.3). */
	readonly url: string
	readonly nowMs: number
	/** For a resource request: the access token the proof must hash into `ath`. */
	readonly accessToken?: string
}

export interface VerifiedDpopProof {
	readonly jkt: string
	readonly jti: string
	readonly iat: number
	readonly jwk: EcPublicJwk
}

const reject = (reason: string, message: string) => Effect.fail(new DpopProofRejected({ reason, message }))

/** Scheme, host and path, normalized the way `URL` does (lowercase host, no default port). */
export const normalizeHtu = (value: string): Option.Option<string> =>
	URL.canParse(value)
		? Option.some(((url) => `${url.protocol}//${url.host}${url.pathname}`)(new URL(value)))
		: Option.none()

/** The base64url SHA-256 of an access token, as `ath` carries it. */
export const accessTokenHash = (accessToken: string): string => base64url(sha256(accessToken))

export const verifyDpopProof = Effect.fn("DpopProof.verify")(function* (check: DpopProofCheck) {
	const jws = yield* parseCompactJws(check.proof).pipe(
		Effect.mapError(
			(error: JoseError) => new DpopProofRejected({ reason: "malformed", message: error.message }),
		),
	)
	const header = decodeHeader(jws.header)
	if (Option.isNone(header)) {
		return yield* reject("header", "The proof header must have typ dpop+jwt, alg ES256 and a jwk.")
	}
	// No extension may be marked critical: none is understood here (RFC 7515 section 4.1.11).
	if (typeof jws.header === "object" && jws.header !== null && "crit" in jws.header) {
		return yield* reject("header", "The proof header must not carry crit.")
	}
	// A private key in the header would be a client bug worth refusing loudly (section 4.2).
	if ("d" in header.value.jwk)
		return yield* reject("header", "The proof jwk must not contain a private key.")
	const jwk = decodeJwk(header.value.jwk)
	if (Option.isNone(jwk)) return yield* reject("header", "The proof jwk must be an EC P-256 public key.")

	const key = yield* importEcPublicJwk(jwk.value).pipe(
		Effect.mapError((error) => new DpopProofRejected({ reason: "header", message: error.message })),
	)
	const valid = yield* verifyEs256(key, jws).pipe(
		Effect.mapError((error) => new DpopProofRejected({ reason: "signature", message: error.message })),
	)
	if (!valid) return yield* reject("signature", "The proof signature does not verify against its jwk.")

	const payload = decodePayload(jws.payload)
	if (Option.isNone(payload))
		return yield* reject("malformed", "The proof must carry jti, htm, htu and iat.")
	const claims = payload.value

	if (claims.htm !== check.method.toUpperCase()) {
		return yield* reject("htm", "The proof htm does not match the request method.")
	}
	const htu = normalizeHtu(claims.htu)
	const expected = normalizeHtu(check.url)
	if (Option.isNone(htu) || Option.isNone(expected) || htu.value !== expected.value) {
		return yield* reject("htu", "The proof htu does not match the request URL.")
	}
	const nowSeconds = Math.floor(check.nowMs / 1000)
	if (Math.abs(nowSeconds - claims.iat) > DPOP_MAX_SKEW_SECONDS) {
		return yield* reject("iat", "The proof iat is outside the accepted window.")
	}
	if (check.accessToken !== undefined && claims.ath !== accessTokenHash(check.accessToken)) {
		return yield* reject("ath", "The proof ath does not match the access token.")
	}

	return {
		jkt: jwkThumbprint(jwk.value),
		jti: claims.jti,
		iat: claims.iat,
		jwk: jwk.value,
	} satisfies VerifiedDpopProof
})
