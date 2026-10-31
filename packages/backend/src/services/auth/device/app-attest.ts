/**
 * Apple App Attest attestation verification, following Apple's "Validating apps that connect
 * to your server" steps 1-9: chain to the App Attest root, nonce extension, key id, RP id hash,
 * counter, AAGUID and credential id. WebCrypto for signatures; no network calls.
 */
import { DeviceAttestationInvalidError } from "@maple/domain/http"
import { Context, Effect } from "effect"
import { decodeCbor, isCborBytes, isCborMap } from "./cbor"
import {
	bytesEqual,
	type Certificate,
	children,
	ecdsaDerToRaw,
	parseCertificate,
	readTlv,
	TAG,
	value,
} from "./der"
import { arrayBufferView, sha256 } from "./jose"

/** Apple App Attestation Root CA (P-384, valid 2020-03-18 to 2045-03-15), DER as base64. */
export const APPLE_APP_ATTEST_ROOT_CA =
	"MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD"

/** The App Attest trust anchor (DER). Apple's root; tests substitute a generated one. */
export class AppAttestTrustAnchor extends Context.Reference<Uint8Array>(
	"@maple/backend/services/auth/device/AppAttestTrustAnchor",
	{ defaultValue: () => new Uint8Array(Buffer.from(APPLE_APP_ATTEST_ROOT_CA, "base64")) },
) {}

const NONCE_EXTENSION = "1.2.840.113635.100.8.2"
const AAGUID_PRODUCTION = new Uint8Array([...new TextEncoder().encode("appattest"), 0, 0, 0, 0, 0, 0, 0])
const AAGUID_DEVELOPMENT = new TextEncoder().encode("appattestdevelop")

/** Named curves by SPKI parameter OID, with their coordinate size. */
const CURVES = new Map([
	["1.2.840.10045.3.1.7", { namedCurve: "P-256", size: 32 }],
	["1.3.132.0.34", { namedCurve: "P-384", size: 48 }],
])
/** ECDSA signature algorithms by OID. */
const SIGNATURE_HASHES = new Map([
	["1.2.840.10045.4.3.2", "SHA-256"],
	["1.2.840.10045.4.3.3", "SHA-384"],
])

export interface AppAttestInput {
	readonly attestationObject: Uint8Array
	/** The App Attest key id: SHA-256 of the attested public key. */
	readonly keyId: Uint8Array
	readonly clientDataHash: Uint8Array
	/** `<TeamID>.<bundle id>`. */
	readonly appId: string
	readonly allowDevelopment: boolean
	readonly nowMs: number
	/** DER of the trust anchor; Apple's root unless a test substitutes its own. */
	readonly rootCertificate?: Uint8Array
}

export interface AppAttestResult {
	readonly environment: "production" | "development"
	readonly counter: number
	readonly receipt: Uint8Array | undefined
}

const fail = (reason: string, message: string) =>
	Effect.fail(new DeviceAttestationInvalidError({ reason, message }))

/** `child` is within its validity window and signed by `parent`, which is a CA. */
const verifyIssuedBy = (child: Certificate, parent: Certificate, nowMs: number) =>
	Effect.gen(function* () {
		if (!parent.isCa || !bytesEqual(child.issuer, parent.subject)) return false
		if (nowMs < child.notBefore || nowMs > child.notAfter) return false
		const curve = CURVES.get(parent.curve)
		const hash = SIGNATURE_HASHES.get(child.signatureAlgorithm)
		const signature = curve === undefined ? undefined : ecdsaDerToRaw(child.signature, curve.size)
		if (curve === undefined || hash === undefined || signature === undefined) return false
		return yield* Effect.tryPromise({
			try: async () => {
				const key = await crypto.subtle.importKey(
					"spki",
					arrayBufferView(parent.spki),
					{ name: "ECDSA", namedCurve: curve.namedCurve },
					false,
					["verify"],
				)
				return crypto.subtle.verify(
					{ name: "ECDSA", hash },
					key,
					arrayBufferView(signature),
					arrayBufferView(child.tbs),
				)
			},
			catch: () =>
				new DeviceAttestationInvalidError({
					reason: "chain",
					message: "A certificate key could not be read.",
				}),
		})
	})

/** The nonce Apple embeds: `SEQUENCE { [1] EXPLICIT OCTET STRING }`. */
const readNonce = (extension: Uint8Array): Uint8Array | undefined => {
	const sequence = readTlv(extension, 0)
	const [tagged] = sequence?.tag === TAG.sequence ? (children(extension, sequence) ?? []) : []
	const [octets] = tagged?.tag === TAG.context1 ? (children(extension, tagged) ?? []) : []
	return octets?.tag === TAG.octetString ? value(extension, octets) : undefined
}

export const verifyAppAttestation = Effect.fn("AppAttest.verify")(function* (input: AppAttestInput) {
	const decoded = decodeCbor(input.attestationObject)
	if (!isCborMap(decoded)) return yield* fail("format", "The attestation object is not CBOR.")
	const statement = decoded.get("attStmt")
	const authData = decoded.get("authData")
	if (decoded.get("fmt") !== "apple-appattest" || !isCborMap(statement) || !isCborBytes(authData)) {
		return yield* fail("format", "The attestation object is not an apple-appattest attestation.")
	}
	const x5c = statement.get("x5c")
	const receipt = statement.get("receipt")
	if (!Array.isArray(x5c) || x5c.length !== 2 || !x5c.every(isCborBytes)) {
		return yield* fail("format", "The attestation must carry a leaf and an intermediate certificate.")
	}

	// Step 1: leaf -> intermediate -> Apple root, every certificate valid now.
	const root = parseCertificate(
		input.rootCertificate ?? new Uint8Array(Buffer.from(APPLE_APP_ATTEST_ROOT_CA, "base64")),
	)
	const [leaf, intermediate] = x5c.map((der: Uint8Array) => parseCertificate(der))
	if (root === undefined || leaf === undefined || intermediate === undefined) {
		return yield* fail("chain", "A certificate in the attestation does not parse.")
	}
	const rootValid = input.nowMs >= root.notBefore && input.nowMs <= root.notAfter
	const intermediateOk = yield* verifyIssuedBy(intermediate, root, input.nowMs)
	const leafOk = yield* verifyIssuedBy(leaf, intermediate, input.nowMs)
	if (!rootValid || !intermediateOk || !leafOk) {
		return yield* fail("chain", "The certificate chain does not lead to the App Attest root.")
	}

	// Steps 2-4: nonce = SHA-256(authData || clientDataHash) is the leaf's extension value.
	const nonceExtension = leaf.extensions.get(NONCE_EXTENSION)
	const nonce = nonceExtension === undefined ? undefined : readNonce(nonceExtension)
	if (nonce === undefined || !bytesEqual(nonce, sha256(authData, input.clientDataHash))) {
		return yield* fail("nonce", "The attestation does not cover this challenge and key.")
	}

	// Step 5: the key id is the SHA-256 of the attested public key.
	if (!bytesEqual(sha256(leaf.publicKeyPoint), input.keyId)) {
		return yield* fail("key_id", "The attested key does not match the key id.")
	}

	// authData: rpIdHash(32) flags(1) counter(4) aaguid(16) credIdLen(2) credId(...)
	if (authData.length < 55) return yield* fail("auth_data", "The authenticator data is truncated.")
	// Step 6: the RP id is the App ID.
	if (!bytesEqual(authData.subarray(0, 32), sha256(input.appId))) {
		return yield* fail("app_id", "The attestation is for a different app.")
	}
	// Step 7: a fresh key has signed nothing yet.
	const counter = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0)
	if (counter !== 0) return yield* fail("counter", "The attestation counter must be zero.")
	// Step 8: production, or development where this deployment allows it.
	const aaguid = authData.subarray(37, 53)
	const environment = bytesEqual(aaguid, AAGUID_PRODUCTION)
		? "production"
		: bytesEqual(aaguid, AAGUID_DEVELOPMENT) && input.allowDevelopment
			? "development"
			: undefined
	if (environment === undefined)
		return yield* fail("environment", "The attestation environment is not accepted.")
	// Step 9: the credential id is the key id.
	const credentialIdLength = new DataView(authData.buffer, authData.byteOffset + 53, 2).getUint16(0)
	const credentialId = authData.subarray(55, 55 + credentialIdLength)
	if (credentialId.length !== credentialIdLength || !bytesEqual(credentialId, input.keyId)) {
		return yield* fail("credential_id", "The credential id does not match the key id.")
	}

	return {
		environment,
		counter,
		receipt: isCborBytes(receipt) ? receipt : undefined,
	} satisfies AppAttestResult
})
