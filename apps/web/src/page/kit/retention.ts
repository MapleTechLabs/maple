import { RETENTION_PERIODS, type RetentionDays, type RetentionSignal } from "@maple/domain/retention"
import { Array as Arr, Option, String as Str } from "effect"

// What a retention period reads as, and what changing one does, for the Retention tab and a source.

const DAY_MS = 24 * 60 * 60 * 1000

export const SIGNAL_LABELS = {
	traces: "Traces",
	logs: "Logs",
	metrics: "Metrics",
	sessions: "Session replays",
	events: "Product events",
	profiles: "Profiles",
} as const satisfies Record<RetentionSignal, string>

/** What one signal's data is called in a sentence: "Spans older than 7 days...". */
export const SIGNAL_NOUNS = {
	traces: "Spans",
	logs: "Logs",
	metrics: "Metric data points",
	sessions: "Session replays",
	events: "Product events",
	profiles: "Profiles",
} as const satisfies Record<RetentionSignal, string>

export const SIGNAL_DESCRIPTIONS = {
	traces: "Spans and the traces they make up.",
	logs: "Log records and their attributes.",
	metrics: "Sums, gauges and histograms.",
	sessions: "Recordings and their timeline events.",
	events: "Product analytics events and the funnels built on them.",
	profiles: "Continuous profiling samples.",
} as const satisfies Record<RetentionSignal, string>

/** "30 days", "1 week", "2 years". */
export const periodLabel = (days: number): string => {
	switch (days) {
		case 1:
			return "1 day"
		case 7:
			return "1 week"
		case 14:
			return "2 weeks"
		case 180:
			return "6 months"
		case 365:
			return "1 year"
		case 730:
			return "2 years"
		default:
			return `${days} days`
	}
}

/** The options a period select offers, the default marked. */
export const periodOptions = (defaultDays: number) =>
	Arr.map(RETENTION_PERIODS, (days) => ({
		value: String(days),
		label: days === defaultDays ? `${periodLabel(days)} (default)` : periodLabel(days),
	}))

/** A select's value back to a period, when it is one. */
export const parsePeriod = (value: string): Option.Option<RetentionDays> =>
	Arr.findFirst(RETENTION_PERIODS, (days) => String(days) === value)

/**
 * What saving `to` over `from` does. Rows keep the period they were stored under: a shorter one
 * hides older data at once and deletes it as that period ends, so going back before then brings it
 * back; a longer one applies to new data, so the full history fills in over time.
 */
export type RetentionChange =
	| { readonly _tag: "Unchanged" }
	| { readonly _tag: "Shorter"; readonly deletedByMs: number }
	| { readonly _tag: "Longer"; readonly fullHistoryFromMs: number }

export const changeOf = (from: number, to: number, nowMs: number): RetentionChange =>
	to === from
		? { _tag: "Unchanged" }
		: to < from
			? { _tag: "Shorter", deletedByMs: nowMs + (from - to) * DAY_MS }
			: { _tag: "Longer", fullHistoryFromMs: nowMs + (to - from) * DAY_MS }

/** "Dec 25", or "Feb 23, 2027" outside the current year. */
export const dayLabel = (ms: number, nowMs: number, timeZone: string): string => {
	const year = (at: number) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(at)
	const format =
		year(ms) === year(nowMs)
			? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone })
			: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone })
	return format.format(ms)
}

/** The sentence under a changed row, saying what saving it does and when. */
export const changeSentence = (
	signal: RetentionSignal,
	change: RetentionChange,
	to: number,
	nowMs: number,
	timeZone: string,
): string | null => {
	const noun = SIGNAL_NOUNS[signal]
	switch (change._tag) {
		case "Unchanged":
			return null
		case "Shorter":
			return `${noun} older than ${periodLabel(to)} are hidden once you save, and deleted by ${dayLabel(change.deletedByMs, nowMs, timeZone)}. Switch back before then to see them again.`
		case "Longer":
			return `Applies to ${Str.toLowerCase(noun)} received from now on. ${periodLabel(to)} of history fills in by ${dayLabel(change.fullHistoryFromMs, nowMs, timeZone)}.`
	}
}
