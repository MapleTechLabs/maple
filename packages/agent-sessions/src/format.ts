// The session derivations bake a handful of human-readable strings into their output
// (finding labels, turn subtitles, cost text). Those formatters used to come from
// `@maple/ui`, which this package cannot depend on — the API renders the same model into
// MCP text and must not pull React in. The implementations below are copied verbatim from
// `@maple/ui/lib/format`, `@maple/ui/lib/replay-format` and `apps/web/src/lib/billing/currency`
// so the strings stay byte-identical to what the page renders.
//
// `apps/web/src/lib/agent-sessions/format-parity.test.ts` pins the copies to their
// originals — web can import both sides, and it runs a fixed input table through each.
// Edit one of these four functions and that test is where the drift shows up.

/**
 * Format a duration in milliseconds to a human-readable string.
 * - < 1ms: microseconds (μs)
 * - < 1s: milliseconds (ms)
 * - < 60s: seconds (s)
 * - < 1h: minutes (min)
 * - >= 1h: hours (h)
 */
export function formatDuration(ms: number): string {
	if (ms < 1) {
		return `${(ms * 1000).toFixed(0)}μs`
	}
	if (ms < 1000) {
		return `${ms.toFixed(1)}ms`
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(2)}s`
	}
	if (ms < 3_600_000) {
		return `${(ms / 60_000).toFixed(1)}min`
	}
	return `${(ms / 3_600_000).toFixed(1)}h`
}

/**
 * Format a number with compact notation.
 * - |n| >= 1T: displays as e.g. "1.2T"
 * - |n| >= 1B: displays as e.g. "2.5B"
 * - |n| >= 1M: displays as e.g. "1.2M"
 * - |n| >= 1K: displays as e.g. "3.4K"
 * - 0 < |n| < 1: 3 significant digits (e.g. "0.08", "0.0267") — axis ticks for
 *   rates/ratios must not collapse to "0" or trail "0.026666…"
 * - otherwise: locale formatting
 *
 * Compacts negatives too (`-1500` → `"-1.5K"`), which matters for the delta
 * columns on comparison tables.
 */
export function formatNumber(num: number): string {
	const abs = Math.abs(num)
	if (abs >= 1_000_000_000_000) {
		return `${(num / 1_000_000_000_000).toFixed(1)}T`
	}
	if (abs >= 1_000_000_000) {
		return `${(num / 1_000_000_000).toFixed(1)}B`
	}
	if (abs >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(1)}M`
	}
	if (abs >= 1_000) {
		return `${(num / 1_000).toFixed(1)}K`
	}
	if (abs > 0 && abs < 1) {
		return num.toLocaleString(undefined, { maximumSignificantDigits: 3 })
	}
	return num.toLocaleString()
}

/**
 * `6h 12m` / `1m 23s` / `45s`, or `—` for missing/zero durations — a replay
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
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
	const seconds = totalSeconds % 60
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
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
