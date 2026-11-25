// How long each signal is kept, per organization and per source. Pure, so the web app can
// show the same numbers the backend resolves.

import { SourceSignal } from "@maple/primitives"
import { Array as Arr, Option, Schema } from "effect"

/** A signal with a retention period: the same families a source can be limited to. */
export const RetentionSignal = SourceSignal
export type RetentionSignal = SourceSignal

export const RETENTION_SIGNALS: ReadonlyArray<RetentionSignal> = SourceSignal.literals

export const MIN_RETENTION_DAYS = 1
/** The longest any signal can be kept: the top of the storage ladder. */
export const MAX_RETENTION_DAYS = 800

export const RetentionDays = Schema.Int.check(
	Schema.isBetween({ minimum: MIN_RETENTION_DAYS, maximum: MAX_RETENTION_DAYS }),
).annotate({ identifier: "@maple/RetentionDays", title: "Retention Days" })
export type RetentionDays = typeof RetentionDays.Type

/** Days per signal. A signal left out inherits: a source from its organization, an organization from the defaults. */
export const RetentionOverrides = Schema.Struct({
	traces: Schema.optionalKey(RetentionDays),
	logs: Schema.optionalKey(RetentionDays),
	metrics: Schema.optionalKey(RetentionDays),
	sessions: Schema.optionalKey(RetentionDays),
	events: Schema.optionalKey(RetentionDays),
	profiles: Schema.optionalKey(RetentionDays),
}).annotate({ identifier: "@maple/RetentionOverrides", title: "Retention Overrides" })
export type RetentionOverrides = typeof RetentionOverrides.Type

export type RetentionDaysBySignal = Readonly<Record<RetentionSignal, number>>

/** What an organization keeps when it has set nothing: the raw tables' own periods. */
export const DEFAULT_RETENTION_DAYS = {
	traces: 30,
	logs: 30,
	metrics: 90,
	sessions: 30,
	events: 365,
	profiles: 14,
} as const satisfies RetentionDaysBySignal

/** The raw warehouse tables each signal's retention applies to. Rollups keep their own periods. */
export const RETENTION_SIGNAL_DATASOURCES = {
	traces: ["traces"],
	logs: ["logs"],
	metrics: ["metrics_sum", "metrics_gauge", "metrics_histogram", "metrics_exponential_histogram"],
	sessions: ["session_replays", "session_replay_events", "session_events"],
	events: ["product_events"],
	profiles: ["profiles"],
} as const satisfies Readonly<Record<RetentionSignal, ReadonlyArray<string>>>

const bySignal = (days: (signal: RetentionSignal) => number): RetentionDaysBySignal => ({
	traces: days("traces"),
	logs: days("logs"),
	metrics: days("metrics"),
	sessions: days("sessions"),
	events: days("events"),
	profiles: days("profiles"),
})

/** What the organization keeps for each signal from a source with no override of its own. */
export const organizationRetentionDays = (
	organization: RetentionOverrides,
	defaults: RetentionDaysBySignal = DEFAULT_RETENTION_DAYS,
): RetentionDaysBySignal => bySignal((signal) => organization[signal] ?? defaults[signal])

/** What one source keeps: its own override, else the organization's period. */
export const sourceRetentionDays = (
	organization: RetentionOverrides,
	source: RetentionOverrides,
	defaults: RetentionDaysBySignal = DEFAULT_RETENTION_DAYS,
): RetentionDaysBySignal => {
	const inherited = organizationRetentionDays(organization, defaults)
	return bySignal((signal) => source[signal] ?? inherited[signal])
}

/**
 * How far back a read of each signal may reach: the longest any of the organization's sources
 * keeps it. A source that keeps less is cut by its own rows expiring, not by the read.
 */
export const readHorizonDays = (
	organization: RetentionOverrides,
	sources: ReadonlyArray<RetentionOverrides>,
	defaults: RetentionDaysBySignal = DEFAULT_RETENTION_DAYS,
): RetentionDaysBySignal => {
	const inherited = organizationRetentionDays(organization, defaults)
	return bySignal((signal) =>
		Arr.reduce(sources, inherited[signal], (longest, source) =>
			Math.max(longest, source[signal] ?? longest),
		),
	)
}

/**
 * The column a raw table ages its rows by, per table of `RETENTION_SIGNAL_DATASOURCES`.
 * Session replay recordings age from when Maple received them.
 */
export const RETENTION_TIME_COLUMNS = {
	traces: "Timestamp",
	logs: "TimestampTime",
	metrics_sum: "TimeUnix",
	metrics_gauge: "TimeUnix",
	metrics_histogram: "TimeUnix",
	metrics_exponential_histogram: "TimeUnix",
	session_replays: "StartTime",
	session_replay_events: "Timestamp",
	session_events: "Timestamp",
	product_events: "Timestamp",
	profiles: "Timestamp",
} as const satisfies Readonly<Record<(typeof RETENTION_SIGNAL_DATASOURCES)[RetentionSignal][number], string>>

/**
 * The periods rows are physically stored under. A policy keeps its exact days for reads; the
 * row is stamped with the next period up, so tables hold a bounded set of expiry groups.
 */
export const RETENTION_STAMP_LADDER = [3, 7, 14, 30, 60, 90, 180, 365, 550, 800] as const

/** The period a row is stored under for a policy of `days`: the shortest ladder period that covers it. */
export const retentionStampDays = (days: number): number =>
	Option.getOrElse(
		Arr.findFirst(RETENTION_STAMP_LADDER, (period) => period >= days),
		() => MAX_RETENTION_DAYS,
	)

/** Whether a set of overrides sets anything at all. */
export const hasRetentionOverrides = (overrides: RetentionOverrides): boolean =>
	Arr.some(RETENTION_SIGNALS, (signal) => overrides[signal] !== undefined)
