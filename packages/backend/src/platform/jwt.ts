/**
 * Compact JWS minting shared by every token Maple signs (APNs, GitHub App, GCP, AWS OIDC, device
 * tokens, Tinybird): PEM import, base64url, and RS256/ES256 over WebCrypto or HS256 over HMAC.
 */
import { createHmac } from "node:crypto"
import { Effect, Schema, String as Str } from "effect"

export const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const
export const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const
/** WebCrypto ECDSA emits the raw `r || s` form, which is exactly JWS ES256. */
export const ES256_SIGN = { name: "ECDSA", hash: "SHA-256" } as const

/** Internal: a JWT could not be minted. Callers map it to their public error. */
export class JwtSignError extends Schema.TaggedError<JwtSignError>()("@maple/backend/platform/JwtSignError", {
	message: Schema.String,
	reason: Schema.Literals(["encode", "sign"]),
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const base64url = (value: string | Uint8Array | ArrayBuffer): string =>
	(typeof value === "string"
		? Buffer.from(value, "utf8")
		: Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value))
	).toString("base64url")

export const fromBase64url = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64url"))

const derLength = (length: number): Buffer =>
	length < 0x80
		? Buffer.from([length])
		: length < 0x100
			? Buffer.from([0x81, length])
			: length < 0x10000
				? Buffer.from([0x82, length >> 8, length & 0xff])
				: Buffer.from([0x83, length >> 16, (length >> 8) & 0xff, length & 0xff])

const derNode = (tag: number, content: Buffer): Buffer =>
	Buffer.concat([Buffer.from([tag]), derLength(content.length), content])

// INTEGER 0 (version) + AlgorithmIdentifier { rsaEncryption, NULL }.
const PKCS8_RSA_PREFIX = Buffer.from("020100300d06092a864886f70d0101010500", "hex")

/**
 * A PEM private key as the PKCS#8 DER WebCrypto imports. A PKCS#1 body (`BEGIN RSA PRIVATE KEY`,
 * what GitHub downloads) is wrapped in a PrivateKeyInfo; whitespace anywhere is ignored.
 */
export const pemToPkcs8 = (pem: string): ArrayBuffer => {
	const body = Str.replace(
		/\s+/g,
		"",
	)(Str.replace(/-----END[^-]+-----/g, "")(Str.replace(/-----BEGIN[^-]+-----/g, "")(pem)))
	const der = Buffer.from(body, "base64")
	const buf = Str.includes("BEGIN RSA PRIVATE KEY")(pem)
		? derNode(0x30, Buffer.concat([PKCS8_RSA_PREFIX, derNode(0x04, der)]))
		: der
	return new Uint8Array(buf).buffer
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const encodeJsonSync = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** `base64url(header).base64url(payload)`, the part a JWS signature covers. */
const signingInput = (header: unknown, payload: unknown) =>
	Effect.all([encodeJson(header), encodeJson(payload)]).pipe(
		Effect.mapBoth({
			onSuccess: ([h, p]) => `${base64url(h)}.${base64url(p)}`,
			onFailure: (cause) =>
				new JwtSignError({
					message: "The JWT header or payload is not JSON-encodable.",
					reason: "encode",
					cause,
				}),
		}),
	)

/** Sign a compact JWS with a WebCrypto key: `RS256` or `ES256_SIGN`. */
export const signJwt = (
	key: CryptoKey,
	algorithm: typeof RS256 | typeof ES256_SIGN,
	header: unknown,
	payload: unknown,
): Effect.Effect<string, JwtSignError> =>
	Effect.gen(function* () {
		const input = yield* signingInput(header, payload)
		const signature = yield* Effect.tryPromise({
			try: () => crypto.subtle.sign(algorithm, key, new TextEncoder().encode(input)),
			catch: (cause) => new JwtSignError({ message: "JWT signing failed.", reason: "sign", cause }),
		})
		return `${input}.${base64url(signature)}`
	})

/** An HS256 compact JWS. The header and payload are plain JSON objects, so encoding cannot fail. */
export const signHs256Jwt = (secret: string, header: unknown, payload: unknown): string => {
	const input = `${base64url(encodeJsonSync(header))}.${base64url(encodeJsonSync(payload))}`
	return `${input}.${base64url(createHmac("sha256", secret).update(input).digest())}`
}
