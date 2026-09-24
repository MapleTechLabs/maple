// Signal presence
//
// "Has this org ever sent this kind of telemetry, and when did it last arrive?"
// Every empty state in the product needs that answer before it can say anything
// useful: a Logs page with no rows means "wire up a log bridge" for an org that
// has never logged, and "widen the time range" for one that logged an hour ago.
// Without it both collapse into "No logs found", which helps nobody.
//
// Deliberately cheap. The trace/log/metric branches read `service_usage` — an
// hourly per-service rollup, so an org+window predicate touches a handful of
// rows rather than the raw signal tables. Sessions and product events have no
// equivalent rollup, so those branches aggregate their own (already narrow)
// tables group-lessly.
//
// Every branch is group-less, so the union always returns exactly one row per
// signal even when nothing matched — an absent signal reports `count: 0` and a
// zero `lastSeen` rather than dropping out of the result. Callers can therefore
// treat a missing row as a bug, never as "no data".
//
// `firstSeen`/`lastSeen` are stringified for the same reason
// `orgTelemetryPulseQuery` does it: the branches mix `DateTime` (`service_usage`)
// and `DateTime64` (sessions, product events), and emitting the raw columns
// would force a UNION supertype with inconsistent precision.

import * as CH from "@maple-dev/effect-clickhouse/expr"
import { from, param, unionAll, type CHUnionQuery } from "@maple-dev/effect-clickhouse"
import { ProductEvents, ServiceUsage, SessionReplays } from "../tables"
import { hourFloor } from "./query-helpers"

/** The signals an empty state can be missing. Stable — the UI keys copy on these. */
export type TelemetrySignal = "traces" | "logs" | "metrics" | "sessions" | "product_events"

export interface SignalPresenceOutput {
	readonly signal: string
	/** Rows (or rolled-up events) seen in the window. `0` means never received. */
	readonly count: number
	/** ClickHouse datetime literal; '1970-01-01 00:00:00' when the signal is absent. */
	readonly firstSeen: string
	readonly lastSeen: string
}

/**
 * One `service_usage` branch per signal. The window predicate snaps to the hour
 * floor because `service_usage` is keyed on top-of-hour `Hour` — comparing to a
 * raw sub-hour bound misses every partial hour, the same trap
 * `serviceUsageQuery` documents.
 *
 * Each branch filters on its own count column, because `service_usage` carries a
 * row for any service that sent *anything* that hour — without the predicate,
 * `min(Hour)` for logs would report the hour the org first sent traces. Filtering
 * does not cost the zero-row guarantee: these aggregates are group-less, so a
 * branch that matches nothing still returns one row reading `count: 0`.
 */
export function signalPresenceQuery(): CHUnionQuery<SignalPresenceOutput> {
	const traces = from(ServiceUsage)
		.select(($) => ({
			signal: CH.lit("traces"),
			count: CH.sum($.TraceCount),
			firstSeen: CH.toString_(CH.min_($.Hour)),
			lastSeen: CH.toString_(CH.max_($.Hour)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(hourFloor("startTime")),
			$.Hour.lte(hourFloor("endTime")),
			$.TraceCount.gt(0),
		])

	const logs = from(ServiceUsage)
		.select(($) => ({
			signal: CH.lit("logs"),
			count: CH.sum($.LogCount),
			firstSeen: CH.toString_(CH.min_($.Hour)),
			lastSeen: CH.toString_(CH.max_($.Hour)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(hourFloor("startTime")),
			$.Hour.lte(hourFloor("endTime")),
			$.LogCount.gt(0),
		])

	// All four metric shapes count as "metrics are wired" — a service that only
	// exports counters is as instrumented as one exporting histograms, and the
	// empty state's advice ("add a metric reader") is identical either way.
	const metrics = from(ServiceUsage)
		.select(($) => ({
			signal: CH.lit("metrics"),
			count: CH.sum($.SumMetricCount)
				.add(CH.sum($.GaugeMetricCount))
				.add(CH.sum($.HistogramMetricCount))
				.add(CH.sum($.ExpHistogramMetricCount)),
			firstSeen: CH.toString_(CH.min_($.Hour)),
			lastSeen: CH.toString_(CH.max_($.Hour)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(hourFloor("startTime")),
			$.Hour.lte(hourFloor("endTime")),
			$.SumMetricCount.add($.GaugeMetricCount)
				.add($.HistogramMetricCount)
				.add($.ExpHistogramMetricCount)
				.gt(0),
		])

	const sessions = from(SessionReplays)
		.select(($) => ({
			signal: CH.lit("sessions"),
			count: CH.count(),
			firstSeen: CH.toString_(CH.min_($.StartTime)),
			lastSeen: CH.toString_(CH.max_($.StartTime)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.StartTime.gte(param.dateTimeString("startTime")),
			$.StartTime.lte(param.dateTimeString("endTime")),
		])

	const productEvents = from(ProductEvents)
		.select(($) => ({
			signal: CH.lit("product_events"),
			count: CH.count(),
			firstSeen: CH.toString_(CH.min_($.Timestamp)),
			lastSeen: CH.toString_(CH.max_($.Timestamp)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
		])

	return unionAll(traces, logs, metrics, sessions, productEvents).format("JSON")
}
