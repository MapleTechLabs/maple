// Top Operations
//
// DSL port of the previously string-interpolated query in
// `observability/top-operations.ts`. Groups spans for one service by SpanName
// and ranks them by the requested metric (count, latency quantiles, error
// rate, or apdex). OrgId-scoped per the Warehouse Query Pattern.

import { finiteOrZero } from "./format"
import { Match } from "effect"
import type { TracesMetric } from "@maple/domain/query-engine"
import * as CH from "@maple-dev/effect-orm/expr"
import { avg, count, countIf, quantile } from "@maple-dev/effect-orm/clickhouse"
import { if_ } from "@maple-dev/effect-orm/clickhouse"
import { param } from "@maple-dev/effect-orm/clickhouse"
import { from } from "@maple-dev/effect-orm/clickhouse"
import { Traces, orgIdParam } from "../tables"
import { deploymentEnvExpr } from "@maple/domain/tinybird/semconv-renames"
import { apdexExprs } from "./query-helpers"
import { displaySpanName, mergedDurationQuantile, serviceOperationWindows } from "./service-operations"

export type TopOperationsMetric = TracesMetric

export interface TopOperationsOpts {
	readonly metric: TopOperationsMetric
	readonly limit?: number
	/** Only spans of this `deployment.environment`. */
	readonly environment?: string
}

export interface TopOperationsOutput {
	readonly name: string
	readonly value: number
}

const durationMs = <N extends number | null>(col: CH.Expr<N>) => col.div(1000000)

const metricExpr = (
	metric: TopOperationsMetric,
	$: { readonly Duration: CH.Expr<number>; readonly StatusCode: CH.Expr<string> },
): CH.Expr<number | null> =>
	Match.value(metric).pipe(
		Match.when("count", () => count()),
		Match.when("avg_duration", () => durationMs(avg($.Duration))),
		Match.when("p50_duration", () => durationMs(quantile(0.5)($.Duration))),
		Match.when("p95_duration", () => durationMs(quantile(0.95)($.Duration))),
		Match.when("p99_duration", () => durationMs(quantile(0.99)($.Duration))),
		Match.when("error_rate", () =>
			if_(count().gt(0), countIf($.StatusCode.eq("Error")).div(count()), CH.lit(0)),
		),
		// The shared definition, so a failed span is frustrated here as it is on the service page.
		Match.when(
			"apdex",
			() => apdexExprs(durationMs($.Duration), 500, $.StatusCode.eq("Error")).apdexScore,
		),
		Match.exhaustive,
	)

/** Every metric but apdex, which needs each span's duration against its thresholds. */
export type RollupTopOperationsMetric = Exclude<TopOperationsMetric, "apdex">

export const isRollupTopOperationsMetric = (
	metric: TopOperationsMetric,
): metric is RollupTopOperationsMetric => metric !== "apdex"

/**
 * Top operations off `service_operations_minutely/_hourly`, with raw spans only
 * for the partial minutes at each end. Names are the rollup's display names
 * (`GET /users/:id`), the same ones the raw path reports.
 */
export function topOperationsRollupQuery(
	opts: Omit<TopOperationsOpts, "metric"> & {
		readonly metric: RollupTopOperationsMetric
		readonly serviceName: string
	},
) {
	return serviceOperationWindows({
		serviceName: opts.serviceName,
		...(opts.environment === undefined ? undefined : { environments: [opts.environment] }),
	})
		.select(($) => {
			const spanCount = CH.sum($.bSpanCount)
			const perSpan = (total: CH.Expr<number>) => if_(spanCount.gt(0), total.div(spanCount), CH.lit(0))
			const value = Match.value(opts.metric).pipe(
				Match.when("count", (): CH.Expr<number> => spanCount),
				Match.when("avg_duration", () => perSpan(CH.sum($.bDurationSum)).div(1_000_000)),
				Match.when("p50_duration", () => mergedDurationQuantile(1)),
				Match.when("p95_duration", () => mergedDurationQuantile(2)),
				Match.when("p99_duration", () => mergedDurationQuantile(3)),
				Match.when("error_rate", () => perSpan(CH.sum($.bErrorCount))),
				Match.exhaustive,
			)
			return { name: $.bSpanName, value: finiteOrZero(value) }
		})
		.groupBy("name")
		.orderBy(["value", "desc"])
		.limit(opts.limit ?? 20)
		.format("JSON")
}

/** Raw spans over the whole window: the apdex path, and clusters without the rollup. */
export function topOperationsQuery(opts: TopOperationsOpts) {
	const limit = opts.limit ?? 20

	return from(Traces)
		.select(($) => ({
			name: displaySpanName($),
			value: finiteOrZero(metricExpr(opts.metric, $)),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.ServiceName.eq(param.string("serviceName")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(opts.environment, (v: string) => deploymentEnvExpr($.ResourceAttributes).eq(v)),
		])
		.groupBy("name")
		.orderBy(["value", "desc"])
		.limit(limit)
		.format("JSON")
}
