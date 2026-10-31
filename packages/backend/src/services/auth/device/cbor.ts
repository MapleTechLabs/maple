/**
 * A bounded CBOR (RFC 8949) decoder for App Attest attestation objects: definite-length
 * integers, byte and text strings, arrays, maps and simple values. Anything else, or anything
 * past the depth and size limits, decodes to `undefined` rather than throwing.
 */

export type CborValue =
	| number
	| string
	| boolean
	| null
	| Uint8Array
	| ReadonlyArray<CborValue>
	| ReadonlyMap<CborValue, CborValue>

interface Decoded {
	readonly value: CborValue
	readonly next: number
}

const MAX_DEPTH = 8
const MAX_ITEMS = 64

const readHead = (
	bytes: Uint8Array,
	offset: number,
): { major: number; argument: number; next: number } | undefined => {
	const initial = bytes[offset]
	if (initial === undefined) return undefined
	const major = initial >> 5
	const info = initial & 0x1f
	if (info < 24) return { major, argument: info, next: offset + 1 }
	const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
	if (width === 0 || offset + 1 + width > bytes.length) return undefined
	const argument = bytes.subarray(offset + 1, offset + 1 + width).reduce((acc, byte) => acc * 256 + byte, 0)
	return Number.isSafeInteger(argument) ? { major, argument, next: offset + 1 + width } : undefined
}

const decodeMany = (
	bytes: Uint8Array,
	offset: number,
	remaining: number,
	depth: number,
	acc: ReadonlyArray<CborValue>,
): { readonly values: ReadonlyArray<CborValue>; readonly next: number } | undefined => {
	if (remaining === 0) return { values: acc, next: offset }
	const item = decodeItem(bytes, offset, depth)
	return item === undefined
		? undefined
		: decodeMany(bytes, item.next, remaining - 1, depth, [...acc, item.value])
}

const decodeItem = (bytes: Uint8Array, offset: number, depth: number): Decoded | undefined => {
	const head = readHead(bytes, offset)
	if (head === undefined || depth > MAX_DEPTH) return undefined
	const { major, argument, next } = head
	switch (major) {
		case 0:
			return { value: argument, next }
		case 1:
			return { value: -1 - argument, next }
		case 2:
		case 3: {
			const end = next + argument
			if (end > bytes.length) return undefined
			const slice = bytes.slice(next, end)
			return { value: major === 2 ? slice : new TextDecoder().decode(slice), next: end }
		}
		case 4: {
			if (argument > MAX_ITEMS) return undefined
			const items = decodeMany(bytes, next, argument, depth + 1, [])
			return items === undefined ? undefined : { value: items.values, next: items.next }
		}
		case 5: {
			if (argument > MAX_ITEMS) return undefined
			const items = decodeMany(bytes, next, argument * 2, depth + 1, [])
			if (items === undefined) return undefined
			const pairs = Array.from(
				{ length: argument },
				(_, index) => [items.values[index * 2], items.values[index * 2 + 1]] as const,
			)
			return {
				value: new Map(
					pairs.filter(
						(pair): pair is readonly [CborValue, CborValue] =>
							pair[0] !== undefined && pair[1] !== undefined,
					),
				),
				next: items.next,
			}
		}
		case 7:
			return argument === 20
				? { value: false, next }
				: argument === 21
					? { value: true, next }
					: argument === 22
						? { value: null, next }
						: undefined
		default:
			return undefined
	}
}

/** Decode exactly one item spanning all of `bytes`. */
export const decodeCbor = (bytes: Uint8Array): CborValue | undefined => {
	const item = decodeItem(bytes, 0, 0)
	return item !== undefined && item.next === bytes.length ? item.value : undefined
}

export const isCborMap = (value: CborValue | undefined): value is ReadonlyMap<CborValue, CborValue> =>
	value instanceof Map

export const isCborBytes = (value: CborValue | undefined): value is Uint8Array => value instanceof Uint8Array
