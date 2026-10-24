/**
 * Just enough DER and X.509 to verify an App Attest chain: TLV walking, OIDs, times, SPKI,
 * extensions, and ECDSA signature conversion. Every reader returns `undefined` on malformed
 * input instead of throwing; nothing here trusts a length it has not bounds-checked.
 */

export interface Tlv {
	readonly tag: number
	readonly start: number
	readonly valueStart: number
	readonly end: number
}

export const TAG = {
	boolean: 0x01,
	integer: 0x02,
	bitString: 0x03,
	octetString: 0x04,
	oid: 0x06,
	utcTime: 0x17,
	generalizedTime: 0x18,
	sequence: 0x30,
	context0: 0xa0,
	context1: 0xa1,
	context3: 0xa3,
} as const

export const readTlv = (bytes: Uint8Array, offset: number): Tlv | undefined => {
	const tag = bytes[offset]
	const first = bytes[offset + 1]
	if (tag === undefined || first === undefined) return undefined
	if (first < 0x80) {
		const end = offset + 2 + first
		return end <= bytes.length ? { tag, start: offset, valueStart: offset + 2, end } : undefined
	}
	const lengthBytes = first & 0x7f
	if (lengthBytes === 0 || lengthBytes > 4 || offset + 2 + lengthBytes > bytes.length) return undefined
	const length = bytes
		.subarray(offset + 2, offset + 2 + lengthBytes)
		.reduce((acc, byte) => acc * 256 + byte, 0)
	const valueStart = offset + 2 + lengthBytes
	const end = valueStart + length
	return end <= bytes.length ? { tag, start: offset, valueStart, end } : undefined
}

const childrenFrom = (
	bytes: Uint8Array,
	offset: number,
	end: number,
	acc: ReadonlyArray<Tlv>,
): ReadonlyArray<Tlv> | undefined => {
	if (offset === end) return acc
	const tlv = readTlv(bytes, offset)
	if (tlv === undefined || tlv.end > end || acc.length > 64) return undefined
	return childrenFrom(bytes, tlv.end, end, [...acc, tlv])
}

export const children = (bytes: Uint8Array, tlv: Tlv): ReadonlyArray<Tlv> | undefined =>
	childrenFrom(bytes, tlv.valueStart, tlv.end, [])

export const value = (bytes: Uint8Array, tlv: Tlv): Uint8Array => bytes.subarray(tlv.valueStart, tlv.end)
export const raw = (bytes: Uint8Array, tlv: Tlv): Uint8Array => bytes.subarray(tlv.start, tlv.end)

/** Base-128 arcs, the first byte packing two of them. */
const decodeArcs = (body: Uint8Array): ReadonlyArray<number> =>
	body.reduce<{ arcs: ReadonlyArray<number>; pending: number }>(
		(state, byte) => {
			const pending = state.pending * 128 + (byte & 0x7f)
			return byte & 0x80
				? { arcs: state.arcs, pending }
				: { arcs: [...state.arcs, pending], pending: 0 }
		},
		{ arcs: [], pending: 0 },
	).arcs

export const decodeOid = (bytes: Uint8Array, tlv: Tlv): string | undefined => {
	if (tlv.tag !== TAG.oid || tlv.end === tlv.valueStart) return undefined
	const [head, ...rest] = decodeArcs(value(bytes, tlv))
	if (head === undefined) return undefined
	const first = head < 80 ? Math.floor(head / 40) : 2
	return [first, head - first * 40, ...rest].join(".")
}

const TIME = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/u

export const decodeTime = (bytes: Uint8Array, tlv: Tlv): number | undefined => {
	if (tlv.tag !== TAG.utcTime && tlv.tag !== TAG.generalizedTime) return undefined
	const match = TIME.exec(new TextDecoder().decode(value(bytes, tlv)))
	if (match === null) return undefined
	const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
	if (
		year === undefined ||
		month === undefined ||
		day === undefined ||
		hour === undefined ||
		minute === undefined ||
		second === undefined
	) {
		return undefined
	}
	// RFC 5280 4.1.2.5.1: two-digit years 50-99 are 19xx, 00-49 are 20xx.
	const fullYear = tlv.tag === TAG.utcTime ? (year >= 50 ? 1900 + year : 2000 + year) : year
	return Date.UTC(fullYear, month - 1, day, hour, minute, second)
}

export interface Certificate {
	readonly tbs: Uint8Array
	readonly signatureAlgorithm: string
	/** DER `SEQUENCE { r, s }`. */
	readonly signature: Uint8Array
	readonly issuer: Uint8Array
	readonly subject: Uint8Array
	readonly notBefore: number
	readonly notAfter: number
	readonly spki: Uint8Array
	readonly curve: string
	/** The SPKI's uncompressed EC point (`04 || x || y`). */
	readonly publicKeyPoint: Uint8Array
	readonly isCa: boolean
	/** extnValue contents by dotted OID. */
	readonly extensions: ReadonlyMap<string, Uint8Array>
}

const bitStringBytes = (bytes: Uint8Array, tlv: Tlv): Uint8Array | undefined =>
	tlv.tag === TAG.bitString && bytes[tlv.valueStart] === 0
		? bytes.subarray(tlv.valueStart + 1, tlv.end)
		: undefined

const parseExtension = (der: Uint8Array, entry: Tlv): readonly [string, Uint8Array] | undefined => {
	const parts = children(der, entry) ?? []
	const oid = parts[0] === undefined ? undefined : decodeOid(der, parts[0])
	const octets = parts[parts.length - 1]
	return oid === undefined || octets?.tag !== TAG.octetString ? undefined : [oid, value(der, octets)]
}

const parseExtensions = (der: Uint8Array, wrapper: Tlv | undefined): Map<string, Uint8Array> | undefined => {
	if (wrapper === undefined) return new Map()
	const [list] = children(der, wrapper) ?? []
	const entries = list === undefined ? undefined : children(der, list)
	if (entries === undefined) return undefined
	const parsed = entries.map((entry) => parseExtension(der, entry))
	return parsed.every((entry) => entry !== undefined) ? new Map(parsed) : undefined
}

const BASIC_CONSTRAINTS = "2.5.29.19"

const isCaFrom = (extensions: ReadonlyMap<string, Uint8Array>): boolean => {
	const body = extensions.get(BASIC_CONSTRAINTS)
	if (body === undefined) return false
	const sequence = readTlv(body, 0)
	const [flag] = sequence === undefined ? [] : (children(body, sequence) ?? [])
	return flag?.tag === TAG.boolean && body[flag.valueStart] === 0xff
}

export const parseCertificate = (der: Uint8Array): Certificate | undefined => {
	const certificate = readTlv(der, 0)
	if (certificate?.tag !== TAG.sequence || certificate.end !== der.length) return undefined
	const [tbs, signatureAlgorithm, signatureValue] = children(der, certificate) ?? []
	if (tbs === undefined || signatureAlgorithm === undefined || signatureValue === undefined)
		return undefined
	const fields = children(der, tbs) ?? []
	const offset = fields[0]?.tag === TAG.context0 ? 1 : 0
	const [, , issuer, validity, subject, spki, ...rest] = fields.slice(offset)
	if (issuer === undefined || validity === undefined || subject === undefined || spki === undefined)
		return undefined
	const [notBefore, notAfter] = children(der, validity) ?? []
	const [algorithm, point] = children(der, spki) ?? []
	const [, curveOid] = algorithm === undefined ? [] : (children(der, algorithm) ?? [])
	const [signatureOid] = children(der, signatureAlgorithm) ?? []
	const extensions = parseExtensions(
		der,
		rest.find((field) => field.tag === TAG.context3),
	)
	const notBeforeMs = notBefore === undefined ? undefined : decodeTime(der, notBefore)
	const notAfterMs = notAfter === undefined ? undefined : decodeTime(der, notAfter)
	const curve = curveOid === undefined ? undefined : decodeOid(der, curveOid)
	const signatureAlgorithmOid = signatureOid === undefined ? undefined : decodeOid(der, signatureOid)
	const publicKeyPoint = point === undefined ? undefined : bitStringBytes(der, point)
	const signature = bitStringBytes(der, signatureValue)
	if (
		extensions === undefined ||
		notBeforeMs === undefined ||
		notAfterMs === undefined ||
		curve === undefined ||
		signatureAlgorithmOid === undefined ||
		publicKeyPoint === undefined ||
		signature === undefined
	) {
		return undefined
	}
	return {
		tbs: raw(der, tbs),
		signatureAlgorithm: signatureAlgorithmOid,
		signature,
		issuer: raw(der, issuer),
		subject: raw(der, subject),
		notBefore: notBeforeMs,
		notAfter: notAfterMs,
		spki: raw(der, spki),
		curve,
		publicKeyPoint,
		isCa: isCaFrom(extensions),
		extensions,
	}
}

const leftPad = (bytes: Uint8Array, size: number): Uint8Array | undefined => {
	const firstNonZero = bytes.findIndex((byte) => byte !== 0)
	const trimmed = bytes.subarray(firstNonZero === -1 ? bytes.length : firstNonZero)
	if (trimmed.length > size) return undefined
	const out = new Uint8Array(size)
	out.set(trimmed, size - trimmed.length)
	return out
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` to the raw `r || s` WebCrypto verifies. */
export const ecdsaDerToRaw = (der: Uint8Array, size: number): Uint8Array | undefined => {
	const sequence = readTlv(der, 0)
	if (sequence?.tag !== TAG.sequence || sequence.end !== der.length) return undefined
	const [r, s] = children(der, sequence) ?? []
	if (r?.tag !== TAG.integer || s?.tag !== TAG.integer) return undefined
	const rawR = leftPad(value(der, r), size)
	const rawS = leftPad(value(der, s), size)
	if (rawR === undefined || rawS === undefined) return undefined
	const out = new Uint8Array(size * 2)
	out.set(rawR, 0)
	out.set(rawS, size)
	return out
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, index) => byte === b[index])
