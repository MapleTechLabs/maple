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

/** The counter that says what the rule did: dropped records, or redacted values. */
export const effectOf = (action: V2IngestRule["action"], counts: RuleCounts): number =>
	action.type === "drop" ? counts.dropped : counts.redacted_values

/** Matching records a sampling drop rule let through. */
export const keptOf = (counts: RuleCounts): number => Math.max(0, counts.matched - counts.dropped)

/** "1.2M dropped" / "340 values redacted". */
export const headline = (action: V2IngestRule["action"], counts: RuleCounts): string =>
	action.type === "drop"
		? `${formatNumber(counts.dropped)} dropped`
		: `${formatNumber(counts.redacted_values)} values redacted`

/** The line under the headline: bytes kept off the bill and what sampling kept, or the records touched. */
export const detail = (action: V2IngestRule["action"], counts: RuleCounts): string => {
	if (action.type !== "drop") return `in ${formatNumber(counts.matched)} records`
	const kept = keptOf(counts)
	const bytes = `${formatStorageBytes(counts.dropped_bytes)} saved`
	return kept > 0 ? `${bytes} · ${formatNumber(kept)} kept` : bytes
}

/** Sums of `size` consecutive values: 168 hours as 28 six-hour bars. */
export const bucketed = (values: ReadonlyArray<number>, size: number): ReadonlyArray<number> =>
	Arr.map(Arr.chunksOf(values, size), (chunk) => Arr.reduce(chunk, 0, (total, value) => total + value))

/** One rule's `pick` per UTC hour over the last `hours` hours of the window, oldest first. */
export const hourlySeries = (
	stats: V2IngestRuleStats,
	id: string,
	hours: number,
	pick: (entry: V2IngestRuleStats["hourly"][number]) => number,
): ReadonlyArray<number> => {
	const lastHour = hourOf(stats.end_time)
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
