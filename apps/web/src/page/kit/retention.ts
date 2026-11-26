import type { V2RetentionPolicy } from "@maple/domain/http/v2"
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

/** What a viewer without Manage retention reads above the periods, on the org tab and a source. */
export const READ_ONLY_NOTE = "Only people with Manage retention can change these periods. Admin has it."

/** "30 days", "180 days": in days, as the API and the docs name a period. */
export const periodLabel = (days: number): string => (days === 1 ? "1 day" : `${days} days`)

/** The options a period select offers, the default marked when there is one. */
export const periodOptions = (defaultDays?: number) =>
	Arr.map(RETENTION_PERIODS, (days) => ({
		value: String(days),
		label: days === defaultDays ? `${periodLabel(days)} (default)` : periodLabel(days),
	}))

/** A select's value back to a period, when it is one. */
export const parsePeriod = (value: string): Option.Option<RetentionDays> =>
	Arr.findFirst(RETENTION_PERIODS, (days) => String(days) === value)

/** "Dec 25", or "Feb 23, 2027" outside the current year. */
export const dayLabel = (ms: number, nowMs: number, timeZone: string): string => {
	const year = (at: number) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(at)
	const format =
		year(ms) === year(nowMs)
			? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone })
			: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone })
	return format.format(ms)
}

/** One row's edit: the organization's period, or one source's (`null` follows the organization). */
export type RetentionEdit =
	| { readonly _tag: "Organization"; readonly days: number }
	| { readonly _tag: "Source"; readonly sourceId: string; readonly days: number | null }

/**
 * How far back reads reach for `signal` with `edit` applied: the longest any source keeps it,
 * and never less than the organization's period (the default when unset). Saving bounds every
 * signal there, as `read_horizon_days` does.
 */
export const horizonWith = (
	policy: V2RetentionPolicy,
	signal: RetentionSignal,
	edit: RetentionEdit,
): number => {
	const organization = edit._tag === "Organization" ? edit.days : policy.organization.days[signal]
	const listed = Arr.flatMap(policy.sources, (source) => {
		const own =
			edit._tag === "Source" && source.source_id === edit.sourceId ? edit.days : source.set[signal]
		return own === null ? [] : [own]
	})
	const added =
		edit._tag === "Source" &&
		edit.days !== null &&
		!Arr.some(policy.sources, (source) => source.source_id === edit.sourceId)
			? [edit.days]
			: []
	return Arr.reduce([...listed, ...added], organization, Math.max)
}

/** The clock a sentence dates from: `nowMs` is `null` until it has been read. */
export type SentenceClock = Readonly<{ nowMs: number | null; timeZone: string }>

/** How many sources keep `signal` for a period of their own. */
export const overridingSources = (policy: V2RetentionPolicy, signal: RetentionSignal): number =>
	Arr.filter(policy.sources, (source) => source.set[signal] !== null).length

/** " 2 sources keep their own period and are not affected.", or nothing. */
const unaffectedNote = (overriding: number): string =>
	overriding === 0
		? ""
		: overriding === 1
			? " 1 source keeps its own period and is not affected."
			: ` ${overriding} sources keep their own period and are not affected.`

/**
 * The sentence under a changed row, saying what saving does. Rows keep the period in force when
 * they arrived, and reads reach as far as the longest period any source keeps: a shorter period
 * hides data only when that horizon moves in, and a longer one builds up as new data arrives.
 * `sourceCount` is how many sources the organization has, `null` while unknown.
 */
export const changeSentence = (
	policy: V2RetentionPolicy,
	signal: RetentionSignal,
	change: Readonly<{ from: number; to: number; edit: RetentionEdit }>,
	clock: SentenceClock,
	sourceCount: number | null = null,
): string | null => {
	const noun = SIGNAL_NOUNS[signal]
	const lower = Str.toLowerCase(noun)
	if (change.to === change.from) return null
	const isOrganization = change.edit._tag === "Organization"
	const overriding = isOrganization ? overridingSources(policy, signal) : 0
	if (change.to > change.from) {
		// No source follows the organization for this signal: nothing builds up until one does.
		if (isOrganization && sourceCount !== null && sourceCount > 0 && overriding >= sourceCount)
			return `Every source keeps its own period for ${lower}, so none is affected now. A source that follows the organization later keeps ${periodLabel(change.to)}.`
		const history =
			clock.nowMs === null
				? ""
				: ` ${periodLabel(change.to)} of history is there by ${dayLabel(clock.nowMs + change.to * DAY_MS, clock.nowMs, clock.timeZone)}.`
		return `Applies to ${lower} arriving from a minute after you save.${history}${unaffectedNote(overriding)}`
	}
	const before = policy.read_horizon_days[signal]
	const after = horizonWith(policy, signal, change.edit)
	return after < before
		? `${noun} older than ${periodLabel(after)} are hidden once you save. Switch back to see them again while they are still stored.`
		: `${noun} arriving from a minute after you save are kept for ${periodLabel(change.to)}. ${noun} already stored keep the period they arrived under.${unaffectedNote(overriding)}`
}
