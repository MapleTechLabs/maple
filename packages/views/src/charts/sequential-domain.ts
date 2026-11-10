// The domain a sequential colour ramp walks, d3-free: the d3 scale (./plot/color-scale.ts) and the
// legends that label its ramp both derive from it, so a legend never disagrees with its grid.

/** How a value's position along the ramp is computed. */
export type SequentialScaleType = "linear" | "log"

/**
 * A log domain's floor when the data's own minimum cannot serve: a fallback, not a hard floor, since
 * `Math.max(min, 1)` would invert an all-sub-1 domain and paint every value the hottest stop.
 */
const LOG_FALLBACK_FLOOR = 1
/** With no positive minimum, the floor sits two decades below the maximum. */
const LOG_FALLBACK_DECADES = 2

/** The `[lo, hi]` a scale of this type walks: a log domain never touches 0 nor inverts. */
export const resolveSequentialDomain = (
	domain: readonly [number, number],
	scaleType: SequentialScaleType,
): [number, number] => {
	const [min, max] = domain
	if (scaleType !== "log") return [min, max]
	if (!(max > 0)) return [LOG_FALLBACK_FLOOR, LOG_FALLBACK_FLOOR * 10]
	const floor =
		min > 0
			? Math.min(min, max)
			: max > LOG_FALLBACK_FLOOR
				? LOG_FALLBACK_FLOOR
				: max / 10 ** LOG_FALLBACK_DECADES
	return [floor, max]
}
