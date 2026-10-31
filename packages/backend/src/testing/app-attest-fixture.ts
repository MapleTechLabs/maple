/**
 * Test-only: builds synthetic App Attest attestations under a generated root, so tests can
 * exercise every verification step with a challenge and key they control. Real attestations
 * cannot be re-signed; `services/auth/device/fixtures/app-attest.json` covers Apple's own chain.
 */
import { createHash } from "node:crypto"

const sha256 = (...parts: ReadonlyArray<Uint8Array | string>) => {
	const hash = createHash("sha256")
	parts.forEach((part) => hash.update(part))
	return new Uint8Array(hash.digest())
}

const concat = (...parts: ReadonlyArray<Uint8Array>) => new Uint8Array(Buffer.concat(parts))

const length = (size: number): Uint8Array => {
	if (size < 0x80) return new Uint8Array([size])
	const bytes = Buffer.alloc(4)
	bytes.writeUInt32BE(size)
	const trimmed = bytes.subarray(bytes.findIndex((byte) => byte !== 0))
	return concat(new Uint8Array([0x80 | trimmed.length]), trimmed)
}

const tlv = (tag: number, ...contents: ReadonlyArray<Uint8Array>) => {
	const body = concat(...contents)
	return concat(new Uint8Array([tag]), length(body.length), body)
}
const seq = (...contents: ReadonlyArray<Uint8Array>) => tlv(0x30, ...contents)
const integer = (bytes: Uint8Array) =>
	tlv(0x02, (bytes[0] ?? 0) & 0x80 ? concat(new Uint8Array([0]), bytes) : bytes)
const octets = (bytes: Uint8Array) => tlv(0x04, bytes)
const bitString = (bytes: Uint8Array) => tlv(0x03, new Uint8Array([0]), bytes)
const oid = (dotted: string) => {
	const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number)
	const arc = (value: number): ReadonlyArray<number> => {
		const groups = [value & 0x7f]
		const higher = (remaining: number): void => {
			if (remaining > 0) {
				groups.unshift((remaining & 0x7f) | 0x80)
				higher(remaining >> 7)
			}
		}
		higher(value >> 7)
		return groups
	}
	return tlv(0x06, new Uint8Array([a * 40 + b, ...rest.flatMap(arc)]))
}
const utcTime = (ms: number) => {
	const iso = new Date(ms).toISOString()
	return tlv(
		0x17,
		new TextEncoder().encode(
			`${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`,
		),
	)
}
const name = (commonName: string) =>
	seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, new TextEncoder().encode(commonName)))))

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const
const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const

const rawToDer = (raw: Uint8Array) => {
	const trim = (bytes: Uint8Array) =>
		bytes.subarray(
			Math.max(
				0,
				bytes.findIndex((byte) => byte !== 0),
			),
		)
	return seq(integer(trim(raw.subarray(0, 32))), integer(trim(raw.subarray(32))))
}

interface Issuer {
	readonly name: string
	readonly keys: CryptoKeyPair
}

const certificate = async (
	subject: string,
	subjectKey: CryptoKey,
	issuer: Issuer,
	options: {
		readonly ca: boolean
		readonly extensions?: ReadonlyArray<Uint8Array>
		readonly notAfter: number
	},
) => {
	const spki = new Uint8Array(await crypto.subtle.exportKey("spki", subjectKey))
	const extensions = [
		...(options.ca
			? [
					seq(
						oid("2.5.29.19"),
						tlv(0x01, new Uint8Array([0xff])),
						octets(seq(tlv(0x01, new Uint8Array([0xff])))),
					),
				]
			: []),
		...(options.extensions ?? []),
	]
	const tbs = seq(
		tlv(0xa0, integer(new Uint8Array([2]))),
		integer(new Uint8Array([1, 2, 3, 4])),
		seq(oid("1.2.840.10045.4.3.2")),
		name(issuer.name),
		seq(utcTime(Date.UTC(2020, 0, 1)), utcTime(options.notAfter)),
		name(subject),
		spki,
		...(extensions.length > 0 ? [tlv(0xa3, seq(...extensions))] : []),
	)
	const signature = new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256, issuer.keys.privateKey, tbs))
	return seq(tbs, seq(oid("1.2.840.10045.4.3.2")), bitString(rawToDer(signature)))
}

const cborHead = (major: number, value: number) =>
	value < 24
		? new Uint8Array([(major << 5) | value])
		: value < 256
			? new Uint8Array([(major << 5) | 24, value])
			: new Uint8Array([(major << 5) | 25, value >> 8, value & 0xff])
const cborText = (text: string) => {
	const bytes = new TextEncoder().encode(text)
	return concat(cborHead(3, bytes.length), bytes)
}
const cborBytes = (bytes: Uint8Array) => concat(cborHead(2, bytes.length), bytes)

export interface SyntheticAttestationOptions {
	readonly appId: string
	readonly clientDataHash: Uint8Array
	readonly counter?: number
	readonly aaguid?: "production" | "development"
	/** Replace the nonce the leaf commits to, to test a mismatch. */
	readonly nonceOverride?: Uint8Array
	readonly credentialIdOverride?: Uint8Array
	readonly notAfter?: number
}

export interface SyntheticAttestation {
	readonly rootCertificate: Uint8Array
	readonly attestationObject: Uint8Array
	readonly keyId: Uint8Array
}

/** A self-consistent attestation chaining to a fresh root, not Apple's. */
export const makeSyntheticAttestation = async (
	options: SyntheticAttestationOptions,
): Promise<SyntheticAttestation> => {
	const generate = () => crypto.subtle.generateKey(ECDSA_P256, true, ["sign", "verify"])
	const [rootKeys, intermediateKeys, leafKeys] = await Promise.all([generate(), generate(), generate()])
	const notAfter = options.notAfter ?? Date.UTC(2049, 0, 1)
	const root = { name: "Test App Attest Root", keys: rootKeys }
	const intermediate = { name: "Test App Attest CA", keys: intermediateKeys }
	const rootCertificate = await certificate(root.name, rootKeys.publicKey, root, { ca: true, notAfter })
	const intermediateCertificate = await certificate(intermediate.name, intermediateKeys.publicKey, root, {
		ca: true,
		notAfter,
	})

	const point = new Uint8Array(await crypto.subtle.exportKey("raw", leafKeys.publicKey))
	const keyId = sha256(point)
	const credentialId = options.credentialIdOverride ?? keyId
	const counter = Buffer.alloc(4)
	counter.writeUInt32BE(options.counter ?? 0)
	const aaguid =
		options.aaguid === "development"
			? new TextEncoder().encode("appattestdevelop")
			: concat(new TextEncoder().encode("appattest"), new Uint8Array(7))
	const authData = concat(
		sha256(options.appId),
		new Uint8Array([0x40]),
		counter,
		aaguid,
		new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff]),
		credentialId,
	)
	const nonce = options.nonceOverride ?? sha256(authData, options.clientDataHash)
	const nonceExtension = seq(oid("1.2.840.113635.100.8.2"), octets(seq(tlv(0xa1, octets(nonce)))))
	const leafCertificate = await certificate("Test App Attest Leaf", leafKeys.publicKey, intermediate, {
		ca: false,
		extensions: [nonceExtension],
		notAfter,
	})

	const attestationObject = concat(
		cborHead(5, 3),
		cborText("fmt"),
		cborText("apple-appattest"),
		cborText("attStmt"),
		cborHead(5, 2),
		cborText("x5c"),
		cborHead(4, 2),
		cborBytes(leafCertificate),
		cborBytes(intermediateCertificate),
		cborText("receipt"),
		cborBytes(new TextEncoder().encode("test-receipt")),
		cborText("authData"),
		cborBytes(authData),
	)
	return { rootCertificate, attestationObject, keyId }
}
