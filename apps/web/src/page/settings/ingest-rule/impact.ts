import type { V2IngestRule, V2IngestRuleStats } from "@maple/domain/http/v2"
import { formatNumber, formatStorageBytes } from "@maple/ui/lib/format"
import { Array as Arr, DateTime, Option, Schema } from "effect"

// What a rule did, in words and per hour, from the gateway's per-rule counts.

export type RuleCounts = Pick<
	V2IngestRuleStats["rules"][number],
	"matched" | "dropped" | "dropped_bytes" | "redacted_values"
>

const HOUR_MS = 3_600_000

/** The UTC hour of a wire timestamp (ISO-8601 UTC, validated by the schema); `NaN` if unreadable. */
const hourOf = (timestamp: string): number =>
	Option.match(DateTime.make(timestamp), {
		onNone: () => Number.NaN,
		onSome: (time) => Math.floor(DateTime.toEpochMillis(time) / HOUR_MS),
	})

export type Effect = "drop" | "redact"

/**
 * What the rule did in the window: its current action's effect, unless only the other one was
 * counted (the rule changed action inside the window).
 */
export const effectKind = (action: V2IngestRule["action"], counts: RuleCounts): Effect => {
	const own: Effect = action.type === "drop" ? "drop" : "redact"
	const ownCount = own === "drop" ? counts.dropped : counts.redacted_values
	const otherCount = own === "drop" ? counts.redacted_values : counts.dropped
	return ownCount === 0 && otherCount > 0 ? (own === "drop" ? "redact" : "drop") : own
}

/** The counter behind an effect: records dropped, or values redacted. */
export const effectCount = (effect: Effect, counts: RuleCounts): number =>
	effect === "drop" ? counts.dropped : counts.redacted_values

/**
 * "1.2M dropped", "1.2M of 1.4M dropped" when the rule matched more than it dropped, or "340
 * values redacted". Matches above the drops are not "kept": the gateway credits a record several
 * drop rules match to the first that drops it.
 */
export const headline = (effect: Effect, counts: RuleCounts): string => {
	if (effect !== "drop") return `${formatNumber(counts.redacted_values)} values redacted`
	return counts.matched > counts.dropped
		? `${formatNumber(counts.dropped)} of ${formatNumber(counts.matched)} dropped`
		: `${formatNumber(counts.dropped)} dropped`
}

/**
 * The line under the headline. Bytes are the dropped records' encoded size, which is not always
 * what metering discounts (a converted payload is metered by its original body).
 */
export const detail = (effect: Effect, counts: RuleCounts): string => {
	// A rule that changed action inside the window names the other effect too.
	if (effect === "drop") {
		const bytes = `${formatStorageBytes(counts.dropped_bytes)} dropped`
		return counts.redacted_values > 0
			? `${bytes} · ${formatNumber(counts.redacted_values)} values redacted`
			: bytes
	}
	const matched = `${formatNumber(counts.matched)} records matched`
	return counts.dropped > 0 ? `${matched} · ${formatNumber(counts.dropped)} dropped` : matched
}

/** Sums of `size` consecutive values: 168 hours as 28 six-hour bars. */
export const bucketed = (values: ReadonlyArray<number>, size: number): ReadonlyArray<number> =>
	Arr.map(Arr.chunksOf(values, size), (chunk) => Arr.reduce(chunk, 0, (total, value) => total + value))

/** The UTC hour holding the last instant before an exclusive end. */
const lastHourOf = (timestamp: string): number =>
	Option.match(DateTime.make(timestamp), {
		onNone: () => Number.NaN,
		onSome: (time) => Math.floor((DateTime.toEpochMillis(time) - 1) / HOUR_MS),
	})

/**
 * Whole UTC hours ending with the current one: the gateway counts per hour bucket, so a window
 * that starts mid-hour would leave out that hour's bucket entirely.
 */
export const hourWindow = (nowMs: number, hours: number) => {
	const endMs = (Math.floor(nowMs / HOUR_MS) + 1) * HOUR_MS
	return {
		start_time: new Date(endMs - hours * HOUR_MS).toISOString(),
		end_time: new Date(endMs).toISOString(),
	}
}

/** One rule's `pick` per UTC hour over the last `hours` hours of the window, oldest first. */
export const hourlySeries = (
	stats: V2IngestRuleStats,
	id: string,
	hours: number,
	pick: (entry: V2IngestRuleStats["hourly"][number]) => number,
): ReadonlyArray<number> => {
	// The end is exclusive: an end on the hour leaves that hour out.
	const lastHour = lastHourOf(stats.end_time)
	const byHour = new Map(
		Arr.map(
			Arr.filter(stats.hourly, (entry) => entry.id === id),
			(entry) => [hourOf(entry.bucket), pick(entry)],
		),
	)
	return Arr.makeBy(hours, (index) => byHour.get(lastHour - hours + 1 + index) ?? 0)
}

export const ImpactWindow = Schema.Literals(["24h", "7d"])
export type ImpactWindow = typeof ImpactWindow.Type

export const IMPACT_HOURS = { "24h": 24, "7d": 168 } as const satisfies Record<ImpactWindow, number>

/** Hours per bar: one bar an hour for a day, six for a week, so a phone still shows bars. */
export const IMPACT_BAR_HOURS = { "24h": 1, "7d": 6 } as const satisfies Record<ImpactWindow, number>
