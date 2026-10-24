/**
 * The slice of JOSE device credentials need: base64url, RFC 7638 thumbprints for EC P-256
 * keys, and ES256 compact JWS parse/verify over WebCrypto (the one crypto API every runtime
 * Maple deploys to has).
 */
import { createHash } from "node:crypto"
import { Effect, Option, Schema } from "effect"

/** Internal: a JOSE object did not parse or verify. Callers map it to their public error. */
export class JoseError extends Schema.TaggedError<JoseError>()("@maple/backend/auth/device/JoseError", {
	message: Schema.String,
	reason: Schema.String,
}) {}

export const EcPublicJwk = Schema.Struct({
	kty: Schema.Literal("EC"),
	crv: Schema.Literal("P-256"),
	x: Schema.String,
	y: Schema.String,
})
export type EcPublicJwk = Schema.Schema.Type<typeof EcPublicJwk>

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const
const ES256_SIGN = { name: "ECDSA", hash: "SHA-256" } as const
const COORDINATE = /^[A-Za-z0-9_-]{43}$/u

export const base64url = (bytes: Uint8Array | string): string =>
	(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes)).toString("base64url")

/** A copy backed by a plain `ArrayBuffer`, which is what WebCrypto's `BufferSource` accepts. */
export const arrayBufferView = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

export const fromBase64url = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64url"))

export const sha256 = (...parts: ReadonlyArray<Uint8Array | string>): Uint8Array => {
	const hash = createHash("sha256")
	parts.forEach((part) => hash.update(part))
	return new Uint8Array(hash.digest())
}

/** RFC 7638: SHA-256 over the required members in lexicographic order, base64url. */
export const jwkThumbprint = (jwk: EcPublicJwk): string =>
	base64url(sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })))

/** Import an EC P-256 public JWK for ES256 verification; an off-curve point fails here. */
export const importEcPublicJwk = (jwk: EcPublicJwk) =>
	COORDINATE.test(jwk.x) && COORDINATE.test(jwk.y)
		? Effect.tryPromise({
				try: () =>
					crypto.subtle.importKey(
						"jwk",
						{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
						ES256,
						false,
						["verify"],
					),
				catch: () => new JoseError({ message: "The key is not a valid P-256 point.", reason: "jwk" }),
			})
		: Effect.fail(
				new JoseError({ message: "The key coordinates are not 32-byte base64url.", reason: "jwk" }),
			)

export interface CompactJws {
	readonly header: unknown
	readonly payload: unknown
	readonly signingInput: string
	readonly signature: Uint8Array
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const parseJsonSegment = (segment: string): Option.Option<unknown> =>
	/^[A-Za-z0-9_-]*$/u.test(segment)
		? decodeJson(Buffer.from(segment, "base64url").toString("utf8"))
		: Option.none()

/** Split and decode a compact JWS. Verifies nothing. */
export const parseCompactJws = (token: string): Effect.Effect<CompactJws, JoseError> => {
	const parts = token.split(".")
	const [headerPart, payloadPart, signaturePart] = parts
	if (
		parts.length !== 3 ||
		headerPart === undefined ||
		payloadPart === undefined ||
		signaturePart === undefined
	) {
		return Effect.fail(new JoseError({ message: "Not a compact JWS.", reason: "malformed" }))
	}
	const header = parseJsonSegment(headerPart)
	const payload = parseJsonSegment(payloadPart)
	if (Option.isNone(header) || Option.isNone(payload)) {
		return Effect.fail(
			new JoseError({ message: "The JWS header or payload is not JSON.", reason: "malformed" }),
		)
	}
	return Effect.succeed({
		header: header.value,
		payload: payload.value,
		signingInput: `${headerPart}.${payloadPart}`,
		signature: fromBase64url(signaturePart),
	})
}

/** ES256 signatures are raw `r || s` (RFC 7518 section 3.4), 64 bytes. */
export const verifyEs256 = (key: CryptoKey, jws: CompactJws) =>
	jws.signature.length !== 64
		? Effect.succeed(false)
		: Effect.tryPromise({
				try: () =>
					crypto.subtle.verify(
						ES256_SIGN,
						key,
						arrayBufferView(jws.signature),
						new TextEncoder().encode(jws.signingInput),
					),
				catch: () =>
					new JoseError({ message: "Signature verification failed.", reason: "signature" }),
			})

export const signEs256 = (key: CryptoKey, header: unknown, payload: unknown) =>
	Effect.gen(function* () {
		const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
		const signature = yield* Effect.tryPromise({
			try: () => crypto.subtle.sign(ES256_SIGN, key, new TextEncoder().encode(signingInput)),
			catch: () => new JoseError({ message: "Signing failed.", reason: "sign" }),
		})
		return `${signingInput}.${base64url(new Uint8Array(signature))}`
	})

export const ES256_IMPORT = ES256
