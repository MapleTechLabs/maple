/**
 * `value`, or `fallback` when it is 0 or NaN: a divisor, scale or parsed CSS
 * length that must not be zero. Spelled out so a real 0 is never replaced by accident.
 */
export const nonZeroOr = (value: number, fallback: number): number =>
	value === 0 || Number.isNaN(value) ? fallback : value
