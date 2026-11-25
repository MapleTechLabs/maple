// How long each signal is kept, per organization and per source. Pure, so the web app can
// show the same numbers the backend resolves.

import { SourceSignal } from "@maple/primitives"
import { Array as Arr, Option, Schema } from "effect"

/** A signal with a retention period: the same families a source can be limited to. */
export const RetentionSignal = SourceSignal
export type RetentionSignal = SourceSignal

export const RETENTION_SIGNALS: ReadonlyArray<RetentionSignal> = SourceSignal.literals

/**
 * The periods a signal can be kept for. Rows are stored under the same period, so what is
 * set, what is billed and when rows are deleted always agree.
 */
export const RETENTION_PERIODS = [3, 7, 14, 30, 60, 90, 180, 365, 730] as const

export const MIN_RETENTION_DAYS = 3
/** The longest any signal can be kept. */
export const MAX_RETENTION_DAYS = 730

export const RetentionDays = Schema.Literals(RETENTION_PERIODS).annotate({
	identifier: "@maple/RetentionDays",
	title: "Retention Days",
	description: "Days to keep a signal: one of 3, 7, 14, 30, 60, 90, 180, 365 or 730.",
})
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

/** Days per signal as stored or set: an override, or a stored value the gateway rounds up. */
export type RetentionDaysSet = { readonly [Signal in RetentionSignal]?: number }

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
	organization: RetentionDaysSet,
	defaults: RetentionDaysBySignal = DEFAULT_RETENTION_DAYS,
): RetentionDaysBySignal => bySignal((signal) => organization[signal] ?? defaults[signal])

/** What one source keeps: its own override, else the organization's period. */
export const sourceRetentionDays = (
	organization: RetentionDaysSet,
	source: RetentionDaysSet,
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
	organization: RetentionDaysSet,
	sources: ReadonlyArray<RetentionDaysSet>,
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
 * The period a row is stored under for `days`: the shortest period that covers it. A policy
 * only holds `RETENTION_PERIODS`, so this is the identity for one; the gateway applies the
 * same rounding to whatever it reads.
 */
export const retentionStampDays = (days: number): number =>
	Option.getOrElse(
		Arr.findFirst(RETENTION_PERIODS, (period) => period >= days),
		() => MAX_RETENTION_DAYS,
	)

/** Whether a set of overrides sets anything at all. */
export const hasRetentionOverrides = (overrides: RetentionOverrides): boolean =>
	Arr.some(RETENTION_SIGNALS, (signal) => overrides[signal] !== undefined)
