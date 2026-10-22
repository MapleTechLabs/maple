/**
 * Maple's OIDC identity for AWS: customer roles trust tokens this issuer signs, so Maple holds no
 * AWS credential. One RSA key signs them; its public half is the JWKS the API serves.
 */
import { AWS_OIDC_AUDIENCE } from "@maple/domain/aws"
import { Effect, Redacted } from "effect"
import { AwsOidcKeyError } from "./errors"

/** STS accepts a token only while it is valid; Maple mints one right before each call. */
const TOKEN_SECONDS = 300
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const

export interface AwsOidcJwk {
	readonly kty: "RSA"
	readonly n: string
	readonly e: string
	readonly kid: string
	readonly alg: "RS256"
	readonly use: "sig"
}

export interface AwsOidcSigner {
	readonly issuer: string
	readonly jwk: AwsOidcJwk
	/** A token for `subject`, valid from `nowMs` for five minutes. */
	readonly mint: (subject: string, nowMs: number) => Effect.Effect<string, AwsOidcKeyError>
}

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
	Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url")

const pemBody = (pem: string) =>
	Buffer.from(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/gu, "").replace(/\s+/gu, ""), "base64")

/** The discovery document AWS reads from `{issuer}/.well-known/openid-configuration`. */
export const awsOidcDiscovery = (issuer: string) => ({
	issuer,
	jwks_uri: `${issuer}/jwks.json`,
	response_types_supported: ["id_token"],
	subject_types_supported: ["public"],
	id_token_signing_alg_values_supported: ["RS256"],
	claims_supported: ["aud", "exp", "iat", "iss", "sub"],
})

/** The signer for a PKCS#8 PEM RSA key. Its `kid` is the key's RFC 7638 thumbprint. */
export const makeAwsOidcSigner = Effect.fn("makeAwsOidcSigner")(function* (
	issuer: string,
	privateKeyPem: Redacted.Redacted<string>,
) {
	const failed = (message: string) => (cause: unknown) => new AwsOidcKeyError({ message, cause })
	const key = yield* Effect.tryPromise({
		try: () =>
			crypto.subtle.importKey("pkcs8", pemBody(Redacted.value(privateKeyPem)), ALGORITHM, true, [
				"sign",
			]),
		catch: failed("The AWS OIDC signing key is not a PKCS#8 RSA key"),
	})
	const exported = yield* Effect.tryPromise({
		try: () => crypto.subtle.exportKey("jwk", key),
		catch: failed("The AWS OIDC signing key cannot be exported"),
	})
	const { n, e } = exported
	if (n === undefined || e === undefined) {
		return yield* new AwsOidcKeyError({ message: "The AWS OIDC signing key has no public half" })
	}
	const thumbprint = yield* Effect.tryPromise({
		try: () =>
			crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ e, kty: "RSA", n }))),
		catch: failed("Hashing the AWS OIDC key failed"),
	})
	const jwk: AwsOidcJwk = { kty: "RSA", n, e, kid: base64url(thumbprint), alg: "RS256", use: "sig" }
	const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))
	const header = encode({ alg: "RS256", typ: "JWT", kid: jwk.kid })

	const mint = (subject: string, nowMs: number) =>
		Effect.gen(function* () {
			const iat = Math.floor(nowMs / 1000)
			const body = encode({
				iss: issuer,
				sub: subject,
				aud: AWS_OIDC_AUDIENCE,
				iat,
				nbf: iat,
				exp: iat + TOKEN_SECONDS,
			})
			const input = `${header}.${body}`
			const signature = yield* Effect.tryPromise({
				try: () => crypto.subtle.sign(ALGORITHM, key, new TextEncoder().encode(input)),
				catch: failed("Signing the AWS OIDC token failed"),
			})
			return `${input}.${base64url(signature)}`
		})

	return { issuer, jwk, mint } satisfies AwsOidcSigner
})
