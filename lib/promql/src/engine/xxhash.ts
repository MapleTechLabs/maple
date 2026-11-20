// XXH64 (seed 0) and Prometheus' labels.Hash on top of it, so limit_ratio keeps the series Prometheus keeps.

const MASK = (1n << 64n) - 1n
const P1 = 11400714785074694791n
const P2 = 14029467366897019727n
const P3 = 1609587929392839161n
const P4 = 9650029242287828579n
const P5 = 2870177450012600261n

const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK
const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK
const add = (a: bigint, b: bigint): bigint => (a + b) & MASK

const u64 = (b: Uint8Array, i: number): bigint => {
	let x = 0n
	for (let k = 7; k >= 0; k--) x = (x << 8n) | BigInt(b[i + k] ?? 0)
	return x
}

const u32 = (b: Uint8Array, i: number): bigint =>
	BigInt((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)) + BigInt(b[i + 3] ?? 0) * 16777216n

const round = (acc: bigint, input: bigint): bigint => mul(rotl(add(acc, mul(input, P2)), 31n), P1)

const merge = (acc: bigint, v: bigint): bigint => add(mul(acc ^ round(0n, v), P1), P4)

export const xxhash64 = (b: Uint8Array): bigint => {
	const n = b.length
	let i = 0
	let h: bigint
	if (n >= 32) {
		let v1 = add(P1, P2)
		let v2 = P2
		let v3 = 0n
		let v4 = (MASK + 1n - P1) & MASK
		for (; i + 32 <= n; i += 32) {
			v1 = round(v1, u64(b, i))
			v2 = round(v2, u64(b, i + 8))
			v3 = round(v3, u64(b, i + 16))
			v4 = round(v4, u64(b, i + 24))
		}
		h = add(add(rotl(v1, 1n), rotl(v2, 7n)), add(rotl(v3, 12n), rotl(v4, 18n)))
		h = merge(merge(merge(merge(h, v1), v2), v3), v4)
	} else h = P5
	h = add(h, BigInt(n))
	for (; i + 8 <= n; i += 8) h = add(mul(rotl(h ^ round(0n, u64(b, i)), 27n), P1), P4)
	if (i + 4 <= n) {
		h = add(mul(rotl(h ^ mul(u32(b, i), P1), 23n), P2), P3)
		i += 4
	}
	for (; i < n; i++) h = mul(rotl(h ^ mul(BigInt(b[i] ?? 0), P5), 11n), P1)
	h = mul(h ^ (h >> 33n), P2)
	h = mul(h ^ (h >> 29n), P3)
	return h ^ (h >> 32n)
}

const encoder = new TextEncoder()

/** A string as Prometheus' stringlabels stores it: its UTF-8 length (one byte, or 255 and three little-endian bytes), then the bytes. */
const sized = (text: string): ReadonlyArray<number> => {
	const bytes = [...encoder.encode(text)]
	const n = bytes.length
	const size = n < 255 ? [n] : [255, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]
	return [...size, ...bytes]
}

const compareCodePoints = (a: string, b: string): number => {
	const x = [...a]
	const y = [...b]
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0)
		if (d !== 0) return d
	}
	return x.length - y.length
}

/**
 * Prometheus' labels.Hash in its default (stringlabels) build: XXH64 of the labels sorted by name,
 * each name and value written as its length then its bytes.
 */
export const labelsHash = (labels: Readonly<Record<string, string>>): bigint => {
	// Go compares strings as UTF-8 bytes, which is code point order; JS `<` compares UTF-16 units.
	const names = Object.keys(labels).sort((a, b) => compareCodePoints(a, b))
	return xxhash64(new Uint8Array(names.flatMap((name) => [...sized(name), ...sized(labels[name] ?? "")])))
}
