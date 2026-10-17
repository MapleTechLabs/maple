export type NonEmpty<A> = readonly [A, ...ReadonlyArray<A>]

/** Seeded PRNG (mulberry32): the same seed always yields the same fixture rows. */
export interface Prng {
	/** Uniform in [0, 1). */
	readonly next: () => number
	readonly int: (minInclusive: number, maxInclusive: number) => number
	readonly chance: (probability: number) => boolean
	readonly pick: <A>(items: NonEmpty<A>) => A
	readonly weighted: <A>(items: NonEmpty<readonly [A, number]>) => A
	readonly hex: (length: number) => string
	/** Multiplicative jitter around 1, e.g. `spread(0.3)` is in [0.7, 1.3). */
	readonly spread: (amount: number) => number
}

export const makePrng = (seed: number): Prng => {
	const state = { value: seed >>> 0 }
	const next = () => {
		state.value = (state.value + 0x6d2b79f5) >>> 0
		let t = state.value
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1))
	const pick = <A>(items: NonEmpty<A>): A => items[Math.floor(next() * items.length)] ?? items[0]
	const weighted = <A>(items: NonEmpty<readonly [A, number]>): A => {
		const total = items.reduce((sum, [, weight]) => sum + weight, 0)
		const target = next() * total
		const found = items.reduce<{ readonly acc: number; readonly hit: A | undefined }>(
			(state, [item, weight]) =>
				state.hit !== undefined
					? state
					: state.acc + weight > target
						? { acc: state.acc + weight, hit: item }
						: { acc: state.acc + weight, hit: undefined },
			{ acc: 0, hit: undefined },
		)
		return found.hit ?? items[0][0]
	}
	const hex = (length: number) =>
		Array.from({ length }, () => Math.floor(next() * 16).toString(16)).join("")
	return {
		next,
		int,
		chance: (probability) => next() < probability,
		pick,
		weighted,
		hex,
		spread: (amount) => 1 - amount + next() * 2 * amount,
	}
}
