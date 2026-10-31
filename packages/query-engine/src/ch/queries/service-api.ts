// Service API tab: HTTP endpoint totals, per-endpoint rows and timeseries.
//
// Same three-tier splice as ./service-operations (raw edges + minutely edges +
// hourly interior, boundaries from ./rollup-splice), carrying migration 0048's
// HTTP measures. The raw branches compute those measures with the exact SQL the
// view writes (`SERVICE_OPERATIONS_HTTP_MEASURES`), so every tier agrees.
//
// `tiers: "raw"` reads `traces` alone: the fallback for a cluster that lacks the
// rollups or migration 0048's columns.

import { Schema, type DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from, fromUnion, param, unionAll, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { SERVICE_OPERATIONS_HTTP_MEASURES as HTTP } from "@maple/domain/tinybird/http-endpoint-sql"
import { CHNumber } from "../schema"
import { DateTimeUtcFromWarehouse } from "../../datetime"
import { ServiceOperationsHourly, ServiceOperationsMinutely, Traces, orgIdParam } from "../tables"
import { tracesBaseWhereConditions } from "./query-helpers"
import { edgeCondition, hourGrain, minuteGrain, utcInteriorConditions } from "./rollup-splice"
import {
	DURATION_STATE,
	RAW_DURATION_STATE,
	ROLLUP_DURATION_STATE,
	displaySpanName,
	httpEndpointCondition,
	mergedDurationQuantile,
} from "./service-operations"

export type ServiceApiTiers = "spliced" | "raw"

export interface ServiceApiScopeOpts {
	readonly serviceName: string
	readonly environments?: readonly string[]
	/** Defaults to `"spliced"`. */
	readonly tiers?: ServiceApiTiers
}

type RollupColumns = ColumnAccessor<typeof ServiceOperationsMinutely.columns>
type RollupMeasureColumns = Pick<
	RollupColumns,
	| "SpanCount"
	| "EstimatedSpanCount"
	| "ErrorCount"
	| "EstimatedErrorCount"
	| "DurationSum"
	| "HttpClassifiedSpanCount"
	| "HttpStatusCount"
	| "Http4xxCount"
	| "Http5xxCount"
	| "RequestBodyBytes"
	| "RequestBodyCount"
>

const httpMeasure = (sql: string) => CH.rawExpr(sql, T.uint64)

/** Branch measures off raw spans: the view's own expressions. */
const rawMeasures = ($: ColumnAccessor<typeof Traces.columns>) => ({
	bSpanCount: CH.count(),
	bEstimatedSpanCount: CH.sum($.SampleRate),
	bErrorCount: CH.countIf($.StatusCode.eq("Error")),
	bEstimatedErrorCount: CH.sumIf($.SampleRate, $.StatusCode.eq("Error")),
	bDurationSum: CH.sum(CH.rawExpr("toFloat64(Duration)", T.float64)),
	bDurationQuantiles: CH.rawExpr(RAW_DURATION_STATE, DURATION_STATE),
	bHttpClassifiedSpanCount: httpMeasure(HTTP.HttpClassifiedSpanCount),
	bHttpStatusCount: httpMeasure(HTTP.HttpStatusCount),
	bHttp4xxCount: httpMeasure(HTTP.Http4xxCount),
	bHttp5xxCount: httpMeasure(HTTP.Http5xxCount),
	bRequestBodyBytes: httpMeasure(HTTP.RequestBodyBytes),
	bRequestBodyCount: httpMeasure(HTTP.RequestBodyCount),
})

/** Branch measures off either rollup tier; the column sets are identical. */
const rollupMeasures = ($: RollupMeasureColumns) => ({
	bSpanCount: CH.sum($.SpanCount),
	bEstimatedSpanCount: CH.sum($.EstimatedSpanCount),
	bErrorCount: CH.sum($.ErrorCount),
	bEstimatedErrorCount: CH.sum($.EstimatedErrorCount),
	bDurationSum: CH.sum($.DurationSum),
	bDurationQuantiles: CH.rawExpr(ROLLUP_DURATION_STATE, DURATION_STATE),
	bHttpClassifiedSpanCount: CH.sum($.HttpClassifiedSpanCount),
	bHttpStatusCount: CH.sum($.HttpStatusCount),
	bHttp4xxCount: CH.sum($.Http4xxCount),
	bHttp5xxCount: CH.sum($.Http5xxCount),
	bRequestBodyBytes: CH.sum($.RequestBodyBytes),
	bRequestBodyCount: CH.sum($.RequestBodyCount),
})

const rollupEnvironment = (env: CH.Expr<string>, environments: readonly string[] | undefined) =>
	environments?.length ? CH.inList(env, environments) : undefined

/** HTTP endpoints only, or exactly the named ones when `spanNames` is given. */
const nameFilter = (name: CH.Expr<string>, spanNames: readonly string[] | undefined) =>
	spanNames?.length ? CH.inList(name, spanNames) : httpEndpointCondition(name, true)

/** Per-endpoint branches, unioned. Outer queries merge them per endpoint or overall. */
function endpointWindows(opts: ServiceApiScopeOpts) {
	const spliced = (opts.tiers ?? "spliced") === "spliced"
	const rawEdges = from(Traces)
		.select(($) => ({ bSpanName: displaySpanName($), ...rawMeasures($) }))
		.where(($) => [
			...tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
			spliced ? edgeCondition("Timestamp", minuteGrain) : undefined,
			httpEndpointCondition(displaySpanName($), true),
		])
		.groupBy("bSpanName")
	if (!spliced) return fromUnion(unionAll(rawEdges), "endpoint_windows")

	const minutelyEdges = from(ServiceOperationsMinutely)
		.select(($) => ({ bSpanName: $.SpanName, ...rollupMeasures($) }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.ServiceName.eq(opts.serviceName),
			rollupEnvironment($.DeploymentEnv, opts.environments),
			...utcInteriorConditions($.Minute, minuteGrain),
			edgeCondition("Minute", hourGrain),
			httpEndpointCondition($.SpanName, true),
		])
		.groupBy("bSpanName")

	const hourlyInterior = from(ServiceOperationsHourly)
		.select(($) => ({ bSpanName: $.SpanName, ...rollupMeasures($) }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.ServiceName.eq(opts.serviceName),
			rollupEnvironment($.DeploymentEnv, opts.environments),
			...utcInteriorConditions($.Hour, hourGrain),
			httpEndpointCondition($.SpanName, true),
		])
		.groupBy("bSpanName")

	return fromUnion(unionAll(rawEdges, minutelyEdges, hourlyInterior), "endpoint_windows")
}

const httpOutputs = <
	A extends {
		readonly bHttpClassifiedSpanCount: CH.Expr<number>
		readonly bHttpStatusCount: CH.Expr<number>
		readonly bHttp4xxCount: CH.Expr<number>
		readonly bHttp5xxCount: CH.Expr<number>
		readonly bRequestBodyBytes: CH.Expr<number>
		readonly bRequestBodyCount: CH.Expr<number>
	},
>(
	$: A,
) => ({
	httpClassifiedSpanCount: CH.sum($.bHttpClassifiedSpanCount),
	httpStatusCount: CH.sum($.bHttpStatusCount),
	http4xxCount: CH.sum($.bHttp4xxCount),
	http5xxCount: CH.sum($.bHttp5xxCount),
	requestBodyBytes: CH.sum($.bRequestBodyBytes),
	requestBodyCount: CH.sum($.bRequestBodyCount),
})

// A. Per-endpoint rows

export interface ServiceEndpointsWithHttpOpts extends ServiceApiScopeOpts {
	readonly limit?: number
}

export interface ServiceEndpointsWithHttpOutput {
	readonly spanName: string
	readonly spanCount: number
	readonly estimatedSpanCount: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly errorRate: number
	readonly avgDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly p99DurationMs: number
	readonly httpClassifiedSpanCount: number
	readonly httpStatusCount: number
	readonly http4xxCount: number
	readonly http5xxCount: number
	readonly requestBodyBytes: number
	readonly requestBodyCount: number
}

export const serviceEndpointsWithHttpRowSchema = Schema.Struct({
	spanName: Schema.String,
	spanCount: CHNumber,
	estimatedSpanCount: CHNumber,
	errorCount: CHNumber,
	estimatedErrorCount: CHNumber,
	errorRate: CHNumber,
	avgDurationMs: CHNumber,
	p50DurationMs: CHNumber,
	p95DurationMs: CHNumber,
	p99DurationMs: CHNumber,
	httpClassifiedSpanCount: CHNumber,
	httpStatusCount: CHNumber,
	http4xxCount: CHNumber,
	http5xxCount: CHNumber,
	requestBodyBytes: CHNumber,
	requestBodyCount: CHNumber,
})

export function serviceEndpointsWithHttpQuery(opts: ServiceEndpointsWithHttpOpts) {
	return endpointWindows(opts)
		.select(($) => {
			const spanCount = CH.sum($.bSpanCount)
			const estimatedSpanCount = CH.sum($.bEstimatedSpanCount)
			const estimatedErrorCount = CH.sum($.bEstimatedErrorCount)
			return {
				spanName: $.bSpanName,
				spanCount,
				estimatedSpanCount,
				errorCount: CH.sum($.bErrorCount),
				estimatedErrorCount,
				errorRate: CH.if_(
					estimatedSpanCount.gt(0),
					estimatedErrorCount.div(estimatedSpanCount),
					CH.lit(0),
				),
				avgDurationMs: CH.if_(
					spanCount.gt(0),
					CH.sum($.bDurationSum).div(spanCount).div(1_000_000),
					CH.lit(0),
				),
				p50DurationMs: mergedDurationQuantile(1),
				p95DurationMs: mergedDurationQuantile(2),
				p99DurationMs: mergedDurationQuantile(3),
				...httpOutputs($),
			}
		})
		.groupBy("spanName")
		.orderBy(["estimatedSpanCount", "desc"])
		.limit(opts.limit ?? 25)
		.format("JSON")
}

// B. One row across every HTTP endpoint of the service

export interface ServiceApiTotalsOutput {
	readonly spanCount: number
	readonly estimatedSpanCount: number
	readonly httpClassifiedSpanCount: number
	readonly httpStatusCount: number
	readonly http4xxCount: number
	readonly http5xxCount: number
	readonly requestBodyBytes: number
	readonly requestBodyCount: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly p99DurationMs: number
}

export const serviceApiTotalsRowSchema = Schema.Struct({
	spanCount: CHNumber,
	estimatedSpanCount: CHNumber,
	httpClassifiedSpanCount: CHNumber,
	httpStatusCount: CHNumber,
	http4xxCount: CHNumber,
	http5xxCount: CHNumber,
	requestBodyBytes: CHNumber,
	requestBodyCount: CHNumber,
	p50DurationMs: CHNumber,
	p95DurationMs: CHNumber,
	p99DurationMs: CHNumber,
})

/** Always one row: no GROUP BY, so an empty window reads as zeros. */
export function serviceApiTotalsQuery(opts: ServiceApiScopeOpts) {
	return endpointWindows(opts)
		.select(($) => ({
			spanCount: CH.sum($.bSpanCount),
			estimatedSpanCount: CH.sum($.bEstimatedSpanCount),
			...httpOutputs($),
			p50DurationMs: mergedDurationQuantile(1),
			p95DurationMs: mergedDurationQuantile(2),
			p99DurationMs: mergedDurationQuantile(3),
		}))
		.format("JSON")
}

// C. Timeseries, merged across endpoints or per named endpoint

export interface ServiceApiTimeseriesOpts extends ServiceApiScopeOpts {
	/** Build-time copy of the `bucketSeconds` param: an hour or more unlocks the hourly tier. */
	readonly bucketSeconds: number
	/** Per-endpoint series for these names; omitted means one merged series named `''`. */
	readonly spanNames?: readonly string[]
}

export interface ServiceApiTimeseriesOutput {
	readonly bucket: DateTime.Utc
	readonly spanName: string
	readonly estimatedSpanCount: number
	/** 0 when every span in the bucket predates the status counters. */
	readonly httpClassifiedSpanCount: number
	readonly httpStatusCount: number
	readonly http4xxCount: number
	readonly http5xxCount: number
	readonly requestBodyBytes: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly p99DurationMs: number
}

export const serviceApiTimeseriesRowSchema = Schema.Struct({
	bucket: DateTimeUtcFromWarehouse,
	spanName: Schema.String,
	estimatedSpanCount: CHNumber,
	httpClassifiedSpanCount: CHNumber,
	httpStatusCount: CHNumber,
	http4xxCount: CHNumber,
	http5xxCount: CHNumber,
	requestBodyBytes: CHNumber,
	p50DurationMs: CHNumber,
	p95DurationMs: CHNumber,
	p99DurationMs: CHNumber,
})

const bucketParam = () => param.int("bucketSeconds")

export function serviceApiTimeseriesQuery(opts: ServiceApiTimeseriesOpts) {
	const spliced = (opts.tiers ?? "spliced") === "spliced"
	const perEndpoint = (opts.spanNames?.length ?? 0) > 0
	const seriesName = (name: CH.Expr<string>) => (perEndpoint ? name : CH.lit(""))

	const rawEdges = from(Traces)
		.select(($) => ({
			bBucket: CH.toStartOfInterval($.Timestamp, bucketParam()),
			bSpanName: seriesName(displaySpanName($)),
			...rawMeasures($),
		}))
		.where(($) => [
			...tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
			spliced ? edgeCondition("Timestamp", minuteGrain) : undefined,
			nameFilter(displaySpanName($), opts.spanNames),
		])
		.groupBy("bBucket", "bSpanName")

	// Same tier choice as `serviceOperationsTimeseriesQuery`: an hour bucket has no
	// position inside a sub-hour one, so the hourly tier only joins at >= 3600s.
	const withHourly = opts.bucketSeconds >= 3600
	const minutely = from(ServiceOperationsMinutely)
		.select(($) => ({
			bBucket: CH.toStartOfInterval($.Minute, bucketParam()),
			bSpanName: seriesName($.SpanName),
			...rollupMeasures($),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.ServiceName.eq(opts.serviceName),
			rollupEnvironment($.DeploymentEnv, opts.environments),
			...utcInteriorConditions($.Minute, minuteGrain),
			withHourly ? edgeCondition("Minute", hourGrain) : undefined,
			nameFilter($.SpanName, opts.spanNames),
		])
		.groupBy("bBucket", "bSpanName")

	const hourlyInterior = from(ServiceOperationsHourly)
		.select(($) => ({
			bBucket: CH.toStartOfInterval($.Hour, bucketParam()),
			bSpanName: seriesName($.SpanName),
			...rollupMeasures($),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.ServiceName.eq(opts.serviceName),
			rollupEnvironment($.DeploymentEnv, opts.environments),
			...utcInteriorConditions($.Hour, hourGrain),
			nameFilter($.SpanName, opts.spanNames),
		])
		.groupBy("bBucket", "bSpanName")

	const combined = !spliced
		? unionAll(rawEdges)
		: withHourly
			? unionAll(rawEdges, minutely, hourlyInterior)
			: unionAll(rawEdges, minutely)

	return fromUnion(combined, "endpoint_buckets")
		.select(($) => ({
			bucket: $.bBucket,
			spanName: $.bSpanName,
			estimatedSpanCount: CH.sum($.bEstimatedSpanCount),
			httpClassifiedSpanCount: CH.sum($.bHttpClassifiedSpanCount),
			httpStatusCount: CH.sum($.bHttpStatusCount),
			http4xxCount: CH.sum($.bHttp4xxCount),
			http5xxCount: CH.sum($.bHttp5xxCount),
			requestBodyBytes: CH.sum($.bRequestBodyBytes),
			p50DurationMs: mergedDurationQuantile(1),
			p95DurationMs: mergedDurationQuantile(2),
			p99DurationMs: mergedDurationQuantile(3),
		}))
		.groupBy("bucket", "spanName")
		.orderBy(["bucket", "asc"], ["spanName", "asc"])
		.limit(10_000)
		.format("JSON")
}
