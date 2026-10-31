// Formatters whose output is baked into derived data — finding labels, turn
// subtitles, cost text — so the page and the MCP print the same strings. They
// live here, below both `@maple/ui` and `@maple/agent-sessions`, because the
// latter renders on a Worker and cannot pull React in through `@maple/ui`.

/** Two clock parts, dropping a zero second part: "1m 12s", "2h", "3d 4h". */
const clockParts = (big: number, bigUnit: string, small: number, smallUnit: string): string =>
	small === 0 ? `${big}${bigUnit}` : `${big}${bigUnit} ${small}${smallUnit}`

/**
 * Format a duration in milliseconds to a human-readable string.
 * Under a minute: ns, μs, ms, s at a fixed precision per magnitude so columns line up
 * ("72.0ms", "426ms", "2.00s", "41.1s"). From a minute up: clock parts ("1m 12s", "2h 5m",
 * "3d 4h"), dropping a zero trailing part ("1m", "3d"). Each tier is picked after rounding,
 * so 999.96ms reads "1.00s" and 59.99s reads "1m". NaN, Infinity and negatives read "—";
 * callers that show a signed offset format the magnitude and add the sign themselves.
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—"
	if (ms > 0 && ms < 0.0005) return `${Math.max(1, Math.round(ms * 1_000_000))}ns`
	if (Math.round(ms * 1000) < 1000) return `${(ms * 1000).toFixed(0)}μs`
	if (Number(ms.toFixed(1)) < 100) return `${ms.toFixed(1)}ms`
	if (Number(ms.toFixed(0)) < 1000) return `${ms.toFixed(0)}ms`
	const s = ms / 1000
	if (Number(s.toFixed(2)) < 10) return `${s.toFixed(2)}s`
	if (Number(s.toFixed(1)) < 60) return `${s.toFixed(1)}s`
	const totalSeconds = Math.round(s)
	if (totalSeconds < 3600) return clockParts(Math.floor(totalSeconds / 60), "m", totalSeconds % 60, "s")
	const totalMinutes = Math.round(ms / 60_000)
	if (totalMinutes < 1440) return clockParts(Math.floor(totalMinutes / 60), "h", totalMinutes % 60, "m")
	const totalHours = Math.round(ms / 3_600_000)
	return clockParts(Math.floor(totalHours / 24), "d", totalHours % 24, "h")
}

/** One decimal, without a trailing ".0": 12.2 reads "12.2", 193.0 reads "193". */
const compactDigits = (value: number): string => {
	const fixed = value.toFixed(1)
	return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed
}

const COMPACT_TIERS = [
	[1_000, "K"],
	[1_000_000, "M"],
	[1_000_000_000, "B"],
	[1_000_000_000_000, "T"],
] as const

/**
 * Format a number with compact notation.
 * - |n| >= 1K: one decimal and an uppercase suffix, no trailing ".0" ("3.4K", "193K",
 *   "1.2M", "2B", "1.5T")
 * - 0 < |n| < 1: 3 significant digits (e.g. "0.08", "0.0267"), so axis ticks for
 *   rates/ratios do not collapse to "0" or trail "0.026666…"
 * - otherwise: locale formatting
 *
 * Compacts negatives too (`-1500` → `"-1.5K"`), which matters for the delta
 * columns on comparison tables. Each tier is picked after rounding, so 999,960 reads "1M".
 */
export function formatNumber(num: number): string {
	if (!Number.isFinite(num)) return "—"
	const abs = Math.abs(num)
	const tier = COMPACT_TIERS.find(
		([size], i) =>
			// A tier above K also takes what the tier below would round to "1000.0".
			abs >= (i === 0 ? size : size * 0.99995) &&
			(i === COMPACT_TIERS.length - 1 || Number((abs / size).toFixed(1)) < 1000),
	)
	if (tier !== undefined) return `${compactDigits(num / tier[0])}${tier[1]}`
	if (abs > 0 && abs < 1) {
		return num.toLocaleString(undefined, { maximumSignificantDigits: 3 })
	}
	return num.toLocaleString()
}

/**
 * `6h 12m` / `1m 23s` / `45s` (a zero trailing part dropped: `2m`), or `—` for missing/zero durations. A replay
 * with no measurable duration is unmeasured, not instantaneous.
 *
 * Named for the session it measures rather than `formatDuration`: this renders a
 * wall-clock span in clock units, which is a different job from the μs→h ladder
 * above. Sharing the name meant the two got imported interchangeably.
 *
 * Minutes roll over at an hour: agent sessions that wait on a human run for
 * hours, and "360m 0s" is not a duration anyone reads as six.
 */
export function formatSessionDuration(ms: number | null): string {
	if (ms == null || ms <= 0) return "—"
	const totalSeconds = Math.round(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	if (minutes >= 60) return clockParts(Math.floor(minutes / 60), "h", minutes % 60, "m")
	const seconds = totalSeconds % 60
	return minutes > 0 ? clockParts(minutes, "m", seconds, "s") : `${seconds}s`
}

const currencyFormatters = new Map<string, Intl.NumberFormat>()

/** Format an amount in dollars (Autumn totals are dollars, not cents). */
export function formatCurrency(amount: number, currency: string): string {
	const key = currency.toUpperCase()
	let formatter = currencyFormatters.get(key)
	if (!formatter) {
		formatter = new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: key,
			minimumFractionDigits: 2,
		})
		currencyFormatters.set(key, formatter)
	}
	return formatter.format(amount)
}
