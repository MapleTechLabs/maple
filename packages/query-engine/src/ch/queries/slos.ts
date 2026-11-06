// Typed SLO Queries
//
// An SLO counts a service's entry-point spans (the spans the service overview counts) as good
// or bad. Counts are sampling-weighted (`SampleRate`), like the service overview's estimates.

import { type DateTime, Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { fromUnion, param, unionAll, type CompiledQueryRowSchema } from "@maple-dev/effect-orm/clickhouse"
import { from } from "@maple-dev/effect-orm/clickhouse"
import type { SloSli } from "@maple/domain/slo"
import { DateTimeUtcFromWarehouse } from "../../datetime"
import { CHNumber } from "../schema"
import { ServiceOverviewHourly, ServiceOverviewMinutely, ServiceOverviewSpans, orgIdParam } from "../tables"
import { serviceOverviewWhereConditions } from "./query-helpers"
import { edgeCondition, hourGrain, minuteGrain, utcInteriorConditions } from "./rollup-splice"

export interface SloSliQueryOpts {
	readonly serviceName: string
	/** Empty counts every environment. */
	readonly environments: readonly string[]
	readonly sli: SloSli
}

/**
 * How a read tiles its window:
 * - `window`: one row for the whole range. Raw spans cover only the partial minutes at each
 *   end, the minutely rollup the partial hours, the hourly rollup the rest.
 * - `hour`: rows bucketed by `bucketSeconds`, a whole number of hours.
 * - `minute`: rows bucketed by `bucketSeconds`, a whole number of minutes under an hour.
 */
export type SloReadGrain = "window" | "hour" | "minute"

const rollupFilters = <
	A extends {
		readonly OrgId: CH.Expr<string>
		readonly ServiceName: CH.Expr<string>
		readonly DeploymentEnv: CH.Expr<string>
	},
>(
	$: A,
	opts: SloSliQueryOpts,
) => [
	$.OrgId.eq(orgIdParam),
	$.ServiceName.eq(opts.serviceName),
	opts.environments.length > 0 ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
]

const nanos = (ms: number) => ms * 1_000_000

/** Exact counts from the per-span projection, for the partial buckets at the window's ends. */
const rawEdges = (opts: SloSliQueryOpts, grain: "hour" | "minute") =>
	from(ServiceOverviewSpans)
		.select(($) => ({
			bBucket: grain === "minute" ? CH.toStartOfMinute($.Timestamp) : CH.toStartOfHour($.Timestamp),
			bTotal: CH.sum($.SampleRate),
			bGood: CH.sumIf(
				$.SampleRate,
				opts.sli._tag === "availability"
					? $.StatusCode.neq("Error")
					: $.Duration.lt(nanos(opts.sli.thresholdMs)),
			),
		}))
		.where(($) => [
			...serviceOverviewWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
			edgeCondition("Timestamp", grain === "minute" ? minuteGrain : hourGrain),
		])
		.groupBy("bBucket")

/** The good-event counter of a rollup row: non-errors, or the ladder column for the threshold. */
const rollupGood = <
	A extends {
		readonly EstimatedSpanCount: CH.Expr<number>
		readonly EstimatedErrorCount: CH.Expr<number>
	},
>(
	$: A,
	sli: SloSli,
) =>
	sli._tag === "availability"
		? CH.sum($.EstimatedSpanCount).sub(CH.sum($.EstimatedErrorCount))
		: CH.sum($.EstimatedSpanCount)

const hourlyInterior = (opts: SloSliQueryOpts) =>
	from(ServiceOverviewHourly)
		.select(($) => ({
			bBucket: $.Hour,
			bTotal: CH.sum($.EstimatedSpanCount),
			bGood: rollupGood($, opts.sli),
		}))
		.where(($) => [...rollupFilters($, opts), ...utcInteriorConditions($.Hour)])
		.groupBy("bBucket")

const minutelyInterior = (opts: SloSliQueryOpts, withinHours: boolean) =>
	from(ServiceOverviewMinutely)
		.select(($) => ({
			bBucket: $.Minute,
			bTotal: CH.sum($.EstimatedSpanCount),
			bGood: rollupGood($, opts.sli),
		}))
		.where(($) => [
			...rollupFilters($, opts),
			...utcInteriorConditions($.Minute, minuteGrain),
			// With the hourly tier present, only the partial hours at each end.
			withinHours ? edgeCondition("Minute", hourGrain) : undefined,
		])
		.groupBy("bBucket")

const sloBuckets = (opts: SloSliQueryOpts, grain: SloReadGrain) => {
	switch (grain) {
		case "window":
			return fromUnion(
				unionAll(rawEdges(opts, "minute"), minutelyInterior(opts, true), hourlyInterior(opts)),
				"slo_buckets",
			)
		case "hour":
			return fromUnion(unionAll(rawEdges(opts, "hour"), hourlyInterior(opts)), "slo_buckets")
		case "minute":
			return fromUnion(unionAll(rawEdges(opts, "minute"), minutelyInterior(opts, false)), "slo_buckets")
	}
}

export interface SloTotalsOutput {
	/** Sampling-weighted entry-point spans in the window. */
	readonly total: number
	/** The good ones among them. */
	readonly good: number
}

export const sloTotalsRowSchema = Schema.Struct({
	total: CHNumber,
	good: CHNumber,
}) satisfies CompiledQueryRowSchema<SloTotalsOutput>

/** Good and total events over `[startTime, endTime]`, one row. */
export function sloTotalsQuery(opts: SloSliQueryOpts) {
	return sloBuckets(opts, "window")
		.select(($) => ({ total: CH.sum($.bTotal), good: CH.sum($.bGood) }))
		.format("JSON")
}

export interface SloBucketsOutput extends SloTotalsOutput {
	readonly bucket: DateTime.Utc
}

export const sloBucketsRowSchema = Schema.Struct({
	bucket: DateTimeUtcFromWarehouse,
	total: CHNumber,
	good: CHNumber,
}) satisfies CompiledQueryRowSchema<SloBucketsOutput>

/**
 * Good and total events per `bucketSeconds` over `[startTime, endTime]`. `hour` needs a bucket
 * that is a whole number of hours; `minute` a whole number of minutes under an hour, since an
 * hourly row has no position inside a sub-hour bucket.
 */
export function sloBucketsQuery(opts: SloSliQueryOpts, grain: "hour" | "minute") {
	return sloBuckets(opts, grain)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.bBucket, param.int("bucketSeconds")),
			total: CH.sum($.bTotal),
			good: CH.sum($.bGood),
		}))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}
