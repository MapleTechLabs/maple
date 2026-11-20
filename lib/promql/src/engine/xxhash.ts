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
const SEP = new Uint8Array([0xff])

/** Prometheus' labels.Hash: XXH64 of `name 0xff value 0xff` over the labels sorted by name. */
export const labelsHash = (labels: Readonly<Record<string, string>>): bigint => {
	const names = Object.keys(labels).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	const parts = names.flatMap((name) => [
		encoder.encode(name),
		SEP,
		encoder.encode(labels[name] ?? ""),
		SEP,
	])
	const out = new Uint8Array(parts.reduce((total, p) => total + p.length, 0))
	parts.reduce((offset, p) => (out.set(p, offset), offset + p.length), 0)
	return xxhash64(out)
}
