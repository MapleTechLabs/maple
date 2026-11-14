import { Array as Arr, Order } from "effect"

/**
 * `value`, or `fallback` when it is 0 or NaN: a divisor, scale or parsed CSS
 * length that must not be zero. Spelled out so a real 0 is never replaced by accident.
 */
export const nonZeroOr = (value: number, fallback: number): number =>
	value === 0 || Number.isNaN(value) ? fallback : value

/** The middle value, the mean of the middle two, or `null` with none. */
export const medianOf = (values: ReadonlyArray<number>): number | null => {
	if (values.length === 0) return null
	const sorted = Arr.sort(values, Order.Number)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}
