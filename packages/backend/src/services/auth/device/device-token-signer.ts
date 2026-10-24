/**
 * Maple's signer for device access tokens and App Attest challenges: one EC P-256 key
 * (`MAPLE_DEVICE_TOKEN_SIGNING_KEY`, PKCS#8 PEM), ES256, `kid` = RFC 7638 thumbprint. Built like
 * the AWS OIDC signer, but a sibling key: different audience, and no customer trusts it.
 */
import { Effect, Option, Redacted, Schema } from "effect"
import {
	ES256_IMPORT,
	EcPublicJwk,
	JoseError,
	jwkThumbprint,
	parseCompactJws,
	signEs256,
	verifyEs256,
} from "./jose"

export const DEVICE_TOKEN_AUDIENCE = "maple-api-device"
export const DEVICE_TOKEN_TYPE = "at+jwt"
export const ATTEST_CHALLENGE_AUDIENCE = "maple-app-attest-challenge"
export const ATTEST_CHALLENGE_TYPE = "maple-attest-challenge+jwt"

export class DeviceTokenKeyError extends Schema.TaggedError<DeviceTokenKeyError>()(
	"@maple/backend/auth/device/DeviceTokenKeyError",
	{ message: Schema.String },
) {}

const SignedHeader = Schema.Struct({
	alg: Schema.Literal("ES256"),
	typ: Schema.String,
	kid: Schema.String,
})
const RegisteredClaims = Schema.Struct({
	iss: Schema.String,
	aud: Schema.String,
	iat: Schema.Number,
	exp: Schema.Number,
})
const decodeSignedHeader = Schema.decodeUnknownOption(SignedHeader)
const decodeRegisteredClaims = Schema.decodeUnknownOption(RegisteredClaims)

export interface DeviceTokenSigner {
	readonly issuer: string
	readonly kid: string
	/** Sign `claims` plus `iss`, `aud`, `iat`, `exp` as a compact JWS of type `typ`. */
	readonly sign: (
		typ: string,
		audience: string,
		claims: Record<string, unknown>,
		nowMs: number,
		ttlSeconds: number,
	) => Effect.Effect<string, JoseError>
	/** Verify signature, `typ`, `kid`, `iss`, `aud` and `exp`; returns the payload undecoded. */
	readonly verify: (
		token: string,
		typ: string,
		audience: string,
		nowMs: number,
	) => Effect.Effect<unknown, JoseError>
}

const pemBody = (pem: string) =>
	Buffer.from(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/gu, "").replace(/\s+/gu, ""), "base64")

export const makeDeviceTokenSigner = Effect.fn("makeDeviceTokenSigner")(function* (
	issuer: string,
	privateKeyPem: Redacted.Redacted<string>,
) {
	const failed = (message: string) => () => new DeviceTokenKeyError({ message })
	const privateKey = yield* Effect.tryPromise({
		try: () =>
			crypto.subtle.importKey("pkcs8", pemBody(Redacted.value(privateKeyPem)), ES256_IMPORT, true, [
				"sign",
			]),
		catch: failed("The device token signing key is not a PKCS#8 P-256 key"),
	})
	const exported = yield* Effect.tryPromise({
		try: () => crypto.subtle.exportKey("jwk", privateKey),
		catch: failed("The device token signing key cannot be exported"),
	})
	const publicJwk = Schema.decodeUnknownOption(EcPublicJwk)({
		kty: exported.kty,
		crv: exported.crv,
		x: exported.x,
		y: exported.y,
	})
	if (Option.isNone(publicJwk)) {
		return yield* new DeviceTokenKeyError({ message: "The device token signing key is not P-256" })
	}
	const publicKey = yield* Effect.tryPromise({
		try: () => crypto.subtle.importKey("jwk", publicJwk.value, ES256_IMPORT, false, ["verify"]),
		catch: failed("The device token signing key has no usable public half"),
	})
	const kid = jwkThumbprint(publicJwk.value)

	const sign: DeviceTokenSigner["sign"] = (typ, audience, claims, nowMs, ttlSeconds) => {
		const iat = Math.floor(nowMs / 1000)
		return signEs256(
			privateKey,
			{ alg: "ES256", typ, kid },
			{ ...claims, iss: issuer, aud: audience, iat, exp: iat + ttlSeconds },
		)
	}

	const verify: DeviceTokenSigner["verify"] = (token, typ, audience, nowMs) =>
		Effect.gen(function* () {
			const invalid = (reason: string, message: string) =>
				Effect.fail(new JoseError({ reason, message }))
			const jws = yield* parseCompactJws(token)
			const header = decodeSignedHeader(jws.header)
			if (Option.isNone(header) || header.value.typ !== typ || header.value.kid !== kid) {
				return yield* invalid("header", "The token was not issued by this server.")
			}
			if (!(yield* verifyEs256(publicKey, jws)))
				return yield* invalid("signature", "The token signature is invalid.")
			const claims = decodeRegisteredClaims(jws.payload)
			if (Option.isNone(claims) || claims.value.iss !== issuer || claims.value.aud !== audience) {
				return yield* invalid("claims", "The token issuer or audience is wrong.")
			}
			if (claims.value.exp <= Math.floor(nowMs / 1000))
				return yield* invalid("expired", "The token has expired.")
			return jws.payload
		})

	return { issuer, kid, sign, verify } satisfies DeviceTokenSigner
})
