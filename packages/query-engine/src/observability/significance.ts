/** Fewer occurrences than this on the busier side is noise, whatever the ratio. */
export const MIN_COUNT = 5
/** A share or rate has to at least double (or halve) to count as a change. */
export const MIN_RATIO = 2
/** Two-proportion z-score a change needs, so a 6-vs-2 sampling wobble is not a regression. */
export const MIN_Z = 3

/** Two-proportion z-score of `a` of `nA` against `b` of `nB`; positive when `a`'s share is higher. */
export const zScore = (a: number, nA: number, b: number, nB: number): number => {
	const pooled = (a + b) / (nA + nB)
	const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB))
	return se === 0 ? 0 : (a / nA - b / nB) / se
}
