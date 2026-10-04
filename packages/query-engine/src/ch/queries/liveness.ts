// Telemetry liveness
//
// "Is this signal quiet because it recovered, or because we stopped receiving
// data?" Every automated resolve path must answer that before it reads an
// absent symptom as health. An ingest outage, a sampling change, or an org
// hitting its billing limit all look exactly like a fixed incident from the
// evaluator's point of view.
//
// Two probes, both deliberately cheap:
//
//   `serviceLivenessQuery` — per-service volume from `service_operations_minutely`.
//     Minute grain, and the sorting key is (OrgId, ServiceName, DeploymentEnv,
//     Minute, SpanName), so an org+service+window predicate prunes to almost
//     nothing. It returns exact AND sampling-corrected counts side by side:
//     when `spanCount` collapses while `estimatedSpanCount` holds, sampling
//     changed and the traffic did not — a distinction no single counter can make.
//
//   `orgTelemetryPulseQuery` — org-wide "are we receiving anything at all?".
//     Runs first as a fail-fast: an org that is entirely dark has no healthy
//     signals, only unobserved ones.
//
// Callers compare a verification window against a baseline window ending at
// incident onset; the queries are window-parameterized so one definition serves
// both. Counts are UInt64 and arrive as strings on BYO-ClickHouse, so both
// row schemas are built from `CHNumber` — compile with them or BYO-CH orgs get
// arithmetic over strings.

import { Schema } from "effect"
import * as CH from "@maple-dev/effect-clickhouse/expr"
import {
	from,
	param,
	unionAll,
	type CHUnionQuery,
	type CompiledQueryRowSchema,
} from "@maple-dev/effect-clickhouse"
import { CHNumber } from "../schema"
import { Logs, MetricCatalog, ServiceOperationsMinutely, ServiceOverviewSpans } from "../tables"
import { hourFloor } from "./query-helpers"

export interface ServiceLivenessOutput {
	/** Distinct minutes in the window that carried at least one span. */
	readonly minutesWithData: number
	readonly spanCount: number
	readonly estimatedSpanCount: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	/** ClickHouse datetime literal; '1970-01-01 00:00:00' when the window is empty. */
	readonly lastSeen: string
}

export interface ServiceLivenessOpts {
	/** Narrow to one deployment environment. Omit to span all of them. */
	readonly scopeToEnvironment?: boolean
}

/**
 * Group-less volume aggregate for one service over a bounded window. No
 * groupBy, so this is a single row and a near-empty scan.
 *
 * `lastSeen` is stringified for the same reason the pulse union does it, and
 * because a raw DateTime round-trips inconsistently across the managed and BYO
 * backends.
 */
export function serviceLivenessQuery(opts: ServiceLivenessOpts = {}) {
	return from(ServiceOperationsMinutely)
		.select(($) => ({
			minutesWithData: CH.uniq($.Minute),
			spanCount: CH.sum($.SpanCount),
			estimatedSpanCount: CH.sum($.EstimatedSpanCount),
			errorCount: CH.sum($.ErrorCount),
			estimatedErrorCount: CH.sum($.EstimatedErrorCount),
			lastSeen: CH.toString_(CH.max_($.Minute)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.Minute.gte(param.dateTimeSeconds("startTime")),
			$.Minute.lte(param.dateTimeSeconds("endTime")),
			opts.scopeToEnvironment ? $.DeploymentEnv.eq(param.string("deploymentEnv")) : undefined,
		])
		.format("JSON")
}

export interface TelemetryPulseOutput {
	readonly signal: string
	readonly count: number
	readonly lastSeen: string
}

/**
 * Cheap "are we receiving telemetry right now?" probe for one org. Unions a
 * span branch (`service_overview_spans`, the entry-point MV) and a log branch
 * (`logs`) over a caller-bounded recent window, returning the row count and the
 * most recent timestamp per signal. Each branch is a window-bounded, group-less
 * aggregate so it scans almost nothing.
 *
 * Drives both the local-mode header heartbeat and the auto-resolve fail-fast.
 *
 * `lastSeen` is stringified in both branches: spans carry `DateTime` and logs
 * `DateTime64`, so emitting the raw columns would force a UNION supertype with
 * inconsistent precision. `toString_(max(...))` keeps both branches `String`
 * and yields a stable ClickHouse datetime literal callers can parse.
 *
 * The log branch bounds `TimestampTime` (the sorting/partition key) as well as
 * `Timestamp`; dropping either makes the query scan the partition or return
 * nothing.
 */
export function orgTelemetryPulseQuery(): CHUnionQuery<TelemetryPulseOutput> {
	const spans = from(ServiceOverviewSpans)
		.select(($) => ({
			signal: CH.lit("spans"),
			count: CH.count(),
			lastSeen: CH.toString_(CH.max_($.Timestamp)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
		])

	const logs = from(Logs)
		.select(($) => ({
			signal: CH.lit("logs"),
			count: CH.count(),
			lastSeen: CH.toString_(CH.max_($.Timestamp)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimestampTime.gte(param.dateTimeSeconds("startTime")),
			$.TimestampTime.lte(param.dateTimeSeconds("endTime")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
		])

	return unionAll(spans, logs).format("JSON")
}

/**
 * Newest timestamp per rollup-backed signal (traces, metrics) for one org, over
 * a short caller-bounded window. Traces read `service_operations_minutely`,
 * which counts every span, at minute grain; metrics read `metric_catalog`.
 * Group-less, so each signal always returns one row. Logs, a raw table, are
 * probed by `logsFreshnessQuery` so no union mixes tiers.
 */
export function ingestFreshnessQuery(): CHUnionQuery<TelemetryPulseOutput> {
	const traces = from(ServiceOperationsMinutely)
		.select(($) => ({
			signal: CH.lit("traces"),
			count: CH.sum($.SpanCount),
			lastSeen: CH.toString_(CH.max_($.Minute)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Minute.gte(param.dateTimeSeconds("startTime")),
			$.Minute.lte(param.dateTimeSeconds("endTime")),
		])

	const metrics = from(MetricCatalog)
		.select(($) => ({
			signal: CH.lit("metrics"),
			count: CH.sum($.DataPointCount),
			// An hour row straddling endTime had data inside the window; clamp its
			// LastSeen so a past end_time never reads newer than itself.
			lastSeen: CH.toString_(
				CH.max_(
					CH.if_(
						$.LastSeen.gt(param.dateTimeSeconds("endTime")),
						CH.toDateTime(param.dateTimeString("endTime")),
						$.LastSeen,
					),
				),
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(hourFloor("startTime")),
			$.Hour.lte(hourFloor("endTime")),
			$.LastSeen.gte(param.dateTimeSeconds("startTime")),
			$.FirstSeen.lte(param.dateTimeSeconds("endTime")),
		])

	return unionAll(traces, metrics).format("JSON")
}

/** Exact newest log timestamp for one org; one group-less row. */
export function logsFreshnessQuery() {
	return from(Logs)
		.select(($) => ({
			signal: CH.lit("logs"),
			count: CH.count(),
			lastSeen: CH.toString_(CH.toDateTime(CH.max_($.Timestamp))),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimestampTime.gte(param.dateTimeSeconds("startTime")),
			$.TimestampTime.lte(param.dateTimeSeconds("endTime")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
		])
		.format("JSON")
}

export const ingestFreshnessRowSchema = Schema.Struct({
	signal: Schema.String,
	count: CHNumber,
	lastSeen: Schema.String,
}) satisfies CompiledQueryRowSchema<TelemetryPulseOutput>
