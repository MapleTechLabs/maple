/**
 * The slice of JOSE device credentials need: RFC 7638 thumbprints for EC P-256 keys, and ES256
 * compact JWS parse/verify over WebCrypto. Encoding and signing live in `platform/jwt`.
 */
import { createHash } from "node:crypto"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { base64url, ES256, ES256_SIGN, fromBase64url, signJwt } from "@maple/backend/platform/jwt"

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

const COORDINATE = /^[A-Za-z0-9_-]{43}$/u
const SEGMENT = /^[A-Za-z0-9_-]*$/u

const encodeJsonSync = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Unpadded base64url that re-encodes to itself: no stray bits, so one value has one spelling. */
const isCanonicalBase64url = (value: string): boolean =>
	SEGMENT.test(value) && Buffer.from(value, "base64url").toString("base64url") === value

/** A copy backed by a plain `ArrayBuffer`, which is what WebCrypto's `BufferSource` accepts. */
export const arrayBufferView = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

export const sha256 = (...parts: ReadonlyArray<Uint8Array | string>): Uint8Array => {
	const hash = createHash("sha256")
	Arr.forEach(parts, (part) => hash.update(part))
	return new Uint8Array(hash.digest())
}

/** RFC 7638: SHA-256 over the required members in lexicographic order, base64url. */
export const jwkThumbprint = (jwk: EcPublicJwk): string =>
	base64url(sha256(encodeJsonSync({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })))

/** Import an EC P-256 public JWK for ES256 verification; an off-curve point fails here. */
export const importEcPublicJwk = (jwk: EcPublicJwk) =>
	COORDINATE.test(jwk.x) &&
	COORDINATE.test(jwk.y) &&
	isCanonicalBase64url(jwk.x) &&
	isCanonicalBase64url(jwk.y)
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
				new JoseError({
					message: "The key coordinates are not canonical 32-byte base64url.",
					reason: "jwk",
				}),
			)

export interface CompactJws {
	readonly header: unknown
	readonly payload: unknown
	readonly signingInput: string
	readonly signature: Uint8Array
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const parseJsonSegment = (segment: string): Option.Option<unknown> =>
	SEGMENT.test(segment) ? decodeJson(Buffer.from(segment, "base64url").toString("utf8")) : Option.none()

/** Split and decode a compact JWS. Verifies nothing. */
export const parseCompactJws = (token: string): Effect.Effect<CompactJws, JoseError> => {
	const parts = Str.split(".")(token)
	const [headerPart, payloadPart, signaturePart] = parts
	if (
		parts.length !== 3 ||
		headerPart === undefined ||
		payloadPart === undefined ||
		signaturePart === undefined
	) {
		return Effect.fail(new JoseError({ message: "Not a compact JWS.", reason: "malformed" }))
	}
	if (!SEGMENT.test(signaturePart)) {
		return Effect.fail(
			new JoseError({ message: "The JWS signature is not base64url.", reason: "malformed" }),
		)
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
	signJwt(key, ES256_SIGN, header, payload).pipe(
		Effect.mapError(
			(error) =>
				new JoseError({
					message:
						error.reason === "encode"
							? "The JWS header or payload is not JSON-encodable."
							: "Signing failed.",
					reason: "sign",
				}),
		),
	)
