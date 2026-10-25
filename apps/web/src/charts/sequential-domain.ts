// `resolveSequentialDomain` (packages/ui/src/components/plot/color-scale.ts), copied so the view can
// label a ramp without importing that module's d3-scale.

export type SequentialScaleType = "linear" | "log"

const LOG_FALLBACK_FLOOR = 1
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
