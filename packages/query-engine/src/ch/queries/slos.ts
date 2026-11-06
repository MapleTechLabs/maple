// Typed SLO Queries
//
// An SLO counts a service's entry-point spans (the spans the service overview counts) as good
// or bad. Counts are sampling-weighted (`SampleRate`), like the service overview's estimates.

import { type DateTime, Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { fromUnion, param, unionAll, type CompiledQueryRowSchema } from "@maple-dev/effect-orm/clickhouse"
import { from } from "@maple-dev/effect-orm/clickhouse"
import type { SloLatencyThresholdMs } from "@maple/domain/primitives"
import type { SloSli } from "@maple/domain/slo"
import { SLO_LATENCY_COVERAGE_COLUMN, sloLatencyColumnName } from "@maple/domain/tinybird"
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

/** Which spans a read counts: one or more services, optionally some environments. */
interface SloScope {
	readonly serviceNames: readonly string[]
	/** Empty counts every environment. */
	readonly environments: readonly string[]
	readonly sli: SloSli
}

const scopeOf = (opts: SloSliQueryOpts): SloScope => ({
	serviceNames: [opts.serviceName],
	environments: opts.environments,
	sli: opts.sli,
})

const serviceCondition = (column: CH.Expr<string>, serviceNames: readonly string[]) =>
	serviceNames.length === 1 && serviceNames[0] !== undefined
		? column.eq(serviceNames[0])
		: CH.inList(column, serviceNames)

/** Every tier groups by these, so a read can sum them away or keep a row per service. */
const BUCKET_KEYS = ["bBucket", "bService", "bEnv"] as const

const rollupFilters = <
	A extends {
		readonly OrgId: CH.Expr<string>
		readonly ServiceName: CH.Expr<string>
		readonly DeploymentEnv: CH.Expr<string>
	},
>(
	$: A,
	opts: SloScope,
) => [
	$.OrgId.eq(orgIdParam),
	serviceCondition($.ServiceName, opts.serviceNames),
	opts.environments.length > 0 ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
]

const nanos = (ms: number) => ms * 1_000_000

/** Exact counts from the per-span projection, for the partial buckets at the window's ends. */
const rawEdges = (opts: SloScope, grain: "hour" | "minute") =>
	from(ServiceOverviewSpans)
		.select(($) => ({
			bBucket: grain === "minute" ? CH.toStartOfMinute($.Timestamp) : CH.toStartOfHour($.Timestamp),
			bService: $.ServiceName,
			bEnv: $.DeploymentEnv,
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
				serviceNames: opts.serviceNames,
				environments: opts.environments,
			}),
			edgeCondition("Timestamp", grain === "minute" ? minuteGrain : hourGrain),
		])
		.groupBy(...BUCKET_KEYS)

type LadderColumns = {
	readonly [K in `EstimatedUnder${SloLatencyThresholdMs}Ms`]: CH.Expr<number>
} & { readonly EstimatedLadderSpanCount: CH.Expr<number> }

/**
 * A rollup row's counts: every span and the non-errors, or for latency the spans the ladder
 * covers and those under the threshold. Buckets written before the ladder cover nothing, so
 * they drop out of a latency SLI instead of reading as all slow.
 */
const rollupCounts = <
	A extends {
		readonly EstimatedSpanCount: CH.Expr<number>
		readonly EstimatedErrorCount: CH.Expr<number>
	} & LadderColumns,
>(
	$: A,
	sli: SloSli,
) =>
	sli._tag === "availability"
		? {
				bTotal: CH.sum($.EstimatedSpanCount),
				bGood: CH.sum($.EstimatedSpanCount).sub(CH.sum($.EstimatedErrorCount)),
			}
		: {
				bTotal: CH.sum($[SLO_LATENCY_COVERAGE_COLUMN]),
				bGood: CH.sum($[sloLatencyColumnName(sli.thresholdMs)]),
			}

const hourlyInterior = (opts: SloScope) =>
	from(ServiceOverviewHourly)
		.select(($) => ({
			bBucket: $.Hour,
			bService: $.ServiceName,
			bEnv: $.DeploymentEnv,
			...rollupCounts($, opts.sli),
		}))
		.where(($) => [...rollupFilters($, opts), ...utcInteriorConditions($.Hour)])
		.groupBy(...BUCKET_KEYS)

const minutelyInterior = (opts: SloScope, withinHours: boolean) =>
	from(ServiceOverviewMinutely)
		.select(($) => ({
			bBucket: $.Minute,
			bService: $.ServiceName,
			bEnv: $.DeploymentEnv,
			...rollupCounts($, opts.sli),
		}))
		.where(($) => [
			...rollupFilters($, opts),
			...utcInteriorConditions($.Minute, minuteGrain),
			// With the hourly tier present, only the partial hours at each end.
			withinHours ? edgeCondition("Minute", hourGrain) : undefined,
		])
		.groupBy(...BUCKET_KEYS)

const sloBuckets = (opts: SloScope, grain: SloReadGrain) => {
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
	return sloBuckets(scopeOf(opts), "window")
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
	return sloBuckets(scopeOf(opts), grain)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.bBucket, param.int("bucketSeconds")),
			total: CH.sum($.bTotal),
			good: CH.sum($.bGood),
		}))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

/** A batch read: every service at once, every environment, one row per (service, environment). */
export interface SloGroupQueryOpts {
	readonly serviceNames: readonly string[]
	readonly sli: SloSli
}

export interface SloTotalsByServiceOutput extends SloTotalsOutput {
	readonly serviceName: string
	readonly environment: string
}

export const sloTotalsByServiceRowSchema = Schema.Struct({
	serviceName: Schema.String,
	environment: Schema.String,
	total: CHNumber,
	good: CHNumber,
}) satisfies CompiledQueryRowSchema<SloTotalsByServiceOutput>

/** `sloTotalsQuery` for many services in one read: the SLOs tab sums the rows each SLO counts. */
export function sloTotalsByServiceQuery(opts: SloGroupQueryOpts) {
	return sloBuckets({ serviceNames: opts.serviceNames, environments: [], sli: opts.sli }, "window")
		.select(($) => ({
			serviceName: $.bService,
			environment: $.bEnv,
			total: CH.sum($.bTotal),
			good: CH.sum($.bGood),
		}))
		.groupBy("serviceName", "environment")
		.format("JSON")
}

export interface SloBurnByServiceOutput {
	readonly serviceName: string
	readonly environment: string
	readonly total5: number
	readonly good5: number
	readonly total30: number
	readonly good30: number
	readonly total60: number
	readonly good60: number
	readonly total360: number
	readonly good360: number
}

export const sloBurnByServiceRowSchema = Schema.Struct({
	serviceName: Schema.String,
	environment: Schema.String,
	total5: CHNumber,
	good5: CHNumber,
	total30: CHNumber,
	good30: CHNumber,
	total60: CHNumber,
	good60: CHNumber,
	total360: CHNumber,
	good360: CHNumber,
}) satisfies CompiledQueryRowSchema<SloBurnByServiceOutput>

/** Minute buckets in the `minutes` before `endTime`, as the burn windows count them. */
const inLastMinutes = (minutes: number) =>
	CH.rawCond(
		`(bBucket >= ${minuteGrain.endDt} - INTERVAL ${minutes} MINUTE AND bBucket < ${minuteGrain.endDt})`,
	)

/**
 * The 5m, 30m, 1h and 6h burn windows ending at `endTime` for many services in one minute-grain
 * read over `[startTime, endTime]` (the 6h lookback), one row per (service, environment).
 */
export function sloBurnByServiceQuery(opts: SloGroupQueryOpts) {
	return sloBuckets({ serviceNames: opts.serviceNames, environments: [], sli: opts.sli }, "minute")
		.select(($) => ({
			serviceName: $.bService,
			environment: $.bEnv,
			total5: CH.sumIf($.bTotal, inLastMinutes(5)),
			good5: CH.sumIf($.bGood, inLastMinutes(5)),
			total30: CH.sumIf($.bTotal, inLastMinutes(30)),
			good30: CH.sumIf($.bGood, inLastMinutes(30)),
			total60: CH.sumIf($.bTotal, inLastMinutes(60)),
			good60: CH.sumIf($.bGood, inLastMinutes(60)),
			total360: CH.sumIf($.bTotal, inLastMinutes(360)),
			good360: CH.sumIf($.bGood, inLastMinutes(360)),
		}))
		.groupBy("serviceName", "environment")
		.format("JSON")
}
