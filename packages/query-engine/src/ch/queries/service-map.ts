// ---------------------------------------------------------------------------
// Typed Service Map Queries
//
// Mix of raw-SQL builders (org-wide variants — `*SQL`) and typesafe-DSL
// builders (service-scoped variants — `*Query`). Both styles co-exist because
// the cross-span rollup helper (`serviceMapEdgeJoinSQL`) needs to emit raw
// SQL fragments callable from outside the DSL (the rollup service in
// `apps/api/src/services/ServiceMapRollupService.ts`), while the
// service-detail page builders go fully through `CH.compile()`.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import { escapeClickHouseString } from "../../sql/sql-fragment"
import { compileCH, unsafeCompiledQuery, type CompiledQuery, type CompiledQueryRowSchema } from "../compile"
import { defineCondFn, defineFn } from "../define-fn"
import * as CH from "../expr"
import { param } from "../param"
import { from, fromQuery, fromUnion } from "../query"
import {
	ServiceMapChildren,
	ServiceMapDbEdgesHourly,
	ServiceMapEdgesHourly,
	ServiceMapSpans,
	ServicePlatformsHourly,
	Traces,
} from "../tables"
import { unionAll } from "../union"

// Local CH function declarations used by the live topology-join branch's
// sample-weighting math. Kept here (not promoted to ch/functions/) because
// they're niche and only this builder uses them; promote later if reused.
const _toFloat64 = defineFn<[CH.Expr<unknown>], number>("toFloat64")
const _matchRegex = defineCondFn<[CH.Expr<string>, string]>("match")
const CHNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export interface ServiceDependenciesOpts {
	deploymentEnv?: string
}

export interface ServiceDependenciesOutput {
	readonly sourceService: string
	readonly targetService: string
	readonly callCount: number
	readonly errorCount: number
	readonly avgDurationMs: number
	readonly p95DurationMs: number
	readonly estimatedSpanCount: number
}

const ServiceDependenciesOutputSchema: CompiledQueryRowSchema<ServiceDependenciesOutput> = Schema.Struct({
	sourceService: Schema.String,
	targetService: Schema.String,
	callCount: CHNumber,
	errorCount: CHNumber,
	avgDurationMs: CHNumber,
	p95DurationMs: CHNumber,
	estimatedSpanCount: CHNumber,
})

/**
 * Topology-join SQL that derives service-to-service edges for the half-open
 * window `[startExpr, endExpr)`.
 *
 * The downstream service name is recovered by joining each Client/Producer span
 * to its child Server/Consumer span: modern OTEL instrumentation no longer
 * emits a `peer.service` attribute (only `server.address`, a hostname), so the
 * parent→child span join is the only reliable source of the *logical*
 * downstream service. A ClickHouse materialized view cannot express this
 * cross-span join, which is why `service_map_edges_hourly` is filled by the
 * scheduled `ServiceMapRollupService` rollup rather than an MV.
 *
 * Produces one row per `(OrgId, Hour, SourceService, TargetService,
 * DeploymentEnv)` with the exact column shape of the `service_map_edges_hourly`
 * table — used both by the rollup (one completed hour per call) and by
 * `serviceDependenciesSQL`'s in-progress-hour branch.
 *
 * `SampleRateSum` is computed inline from the child span's `th:` TraceState
 * threshold because `service_map_children` carries no `SampleRate` column.
 *
 * `startExpr` / `endExpr` are raw SQL datetime expressions — the caller is
 * responsible for quoting any literals (e.g. `toDateTime('2026-05-16 09:00:00')`).
 *
 * `orgId` scopes the join to one org. Omit it only for the all-orgs backfill
 * script, which connects to ClickHouse directly; every in-app caller (the
 * rollup and `serviceDependenciesSQL`) must pass it so the query is tenant-scoped.
 */
export function serviceMapEdgeJoinSQL(params: {
	orgId?: string
	startExpr: string
	endExpr: string
	deploymentEnv?: string
	/**
	 * Optional source-service filter applied to the parent (`p`) subquery — the
	 * Client/Producer span emitting the outbound call. Pushing this filter into
	 * the inner SELECT (rather than the outer WHERE) lets ClickHouse skip the
	 * full Client/Producer scan and shrink the JOIN's left side to a single
	 * service's outbound spans. The rollup callers in `service-map-rollup.ts`
	 * omit this so they continue to cover every service.
	 */
	parentServiceName?: string
}): string {
	const esc = escapeClickHouseString
	const orgFilter = params.orgId ? `AND OrgId = '${esc(params.orgId)}'` : ""
	const envFilter = params.deploymentEnv
		? `AND DeploymentEnv = '${esc(params.deploymentEnv)}'`
		: ""
	const parentServiceFilter = params.parentServiceName
		? `AND ServiceName = '${esc(params.parentServiceName)}'`
		: ""
	return `SELECT
      p.OrgId AS OrgId,
      toStartOfHour(p.Timestamp) AS Hour,
      p.ServiceName AS SourceService,
      c.ServiceName AS TargetService,
      p.DeploymentEnv AS DeploymentEnv,
      count() AS CallCount,
      countIf(c.StatusCode = 'Error') AS ErrorCount,
      sum(c.Duration / 1000000) AS DurationSumMs,
      max(c.Duration / 1000000) AS MaxDurationMs,
      countIf(match(c.TraceState, 'th:[0-9a-f]+')) AS SampledSpanCount,
      countIf(NOT match(c.TraceState, 'th:[0-9a-f]+')) AS UnsampledSpanCount,
      sum(multiIf(
        match(c.TraceState, 'th:[0-9a-f]+'),
        1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001),
        1.0
      )) AS SampleRateSum
    FROM (
      SELECT OrgId, Timestamp, TraceId, SpanId, ServiceName, DeploymentEnv
      FROM service_map_spans
      WHERE SpanKind IN ('Client', 'Producer')
        AND Timestamp >= ${params.startExpr}
        AND Timestamp < ${params.endExpr}
        ${orgFilter}
        ${envFilter}
        ${parentServiceFilter}
    ) AS p
    INNER JOIN (
      SELECT TraceId, ParentSpanId, ServiceName, Duration, StatusCode, TraceState
      FROM service_map_children
      WHERE Timestamp >= ${params.startExpr}
        AND Timestamp < ${params.endExpr}
        ${orgFilter}
        ${envFilter}
    ) AS c
    ON p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId
    WHERE p.ServiceName != c.ServiceName
    GROUP BY OrgId, Hour, SourceService, TargetService, DeploymentEnv`
}

export function serviceDependenciesSQL(
	opts: ServiceDependenciesOpts,
	params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ServiceDependenciesOutput> {
	const esc = escapeClickHouseString
	const envFilter = opts.deploymentEnv ? `AND DeploymentEnv = '${esc(opts.deploymentEnv)}'` : ""

	// Inner branches expose distinct alias names (`bucket*`) so the outer
	// SELECT's `sum(...) AS callCount` doesn't collide with an inner
	// `sum(CallCount) AS callCount`. ClickHouse's UNION-ALL+GROUP-BY
	// optimizer otherwise rewrites the outer as `sum(sum(CallCount))` and
	// rejects the query with "found inside another aggregate function".
	//
	// We also carry `bucketDurationSumMs` separately from `bucketCallCount`
	// so the outer can compute a properly-weighted average:
	//   sum(bucketDurationSumMs) / sum(bucketCallCount)
	// instead of `avg(avgDurationMs)` (averaging averages, which ignores
	// the relative call counts of each branch).
	//
	// Time ranges are split so the two branches don't double-count the
	// in-progress hour: the hourly rollup covers complete hourly buckets
	// strictly before `toStartOfHour(endTime)`, the live topology join scans
	// only from there to `endTime`.
	const completedHourEdges = `SELECT
      SourceService AS sourceService,
      TargetService AS targetService,
      sum(CallCount) AS bucketCallCount,
      sum(ErrorCount) AS bucketErrorCount,
      sum(DurationSumMs) AS bucketDurationSumMs,
      max(MaxDurationMs) AS bucketMaxDurationMs,
      sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount
    FROM service_map_edges_hourly
    WHERE OrgId = '${esc(params.orgId)}'
      AND Hour >= toStartOfHour(toDateTime('${esc(params.startTime)}'))
      AND Hour < toStartOfHour(toDateTime('${esc(params.endTime)}'))
      ${envFilter}
    GROUP BY sourceService, targetService`

	// Live topology join for the in-progress hour only — the rollup has not
	// yet sealed this hour into `service_map_edges_hourly`. Reuses the exact
	// SQL the rollup runs (`serviceMapEdgeJoinSQL`) so the two stay in lockstep,
	// then re-aggregates dropping `Hour` into the `bucket*` shape.
	const joinEdges = `SELECT
      SourceService AS sourceService,
      TargetService AS targetService,
      sum(CallCount) AS bucketCallCount,
      sum(ErrorCount) AS bucketErrorCount,
      sum(DurationSumMs) AS bucketDurationSumMs,
      max(MaxDurationMs) AS bucketMaxDurationMs,
      sum(SampleRateSum) AS bucketEstimatedSpanCount
    FROM (
      ${serviceMapEdgeJoinSQL({
				orgId: params.orgId,
				startExpr: `toStartOfHour(toDateTime('${esc(params.endTime)}'))`,
				endExpr: `toDateTime('${esc(params.endTime)}')`,
				deploymentEnv: opts.deploymentEnv,
			})}
    )
    GROUP BY sourceService, targetService`

	const sql = `SELECT
  sourceService,
  targetService,
  sum(bucketCallCount) AS callCount,
  sum(bucketErrorCount) AS errorCount,
  sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
  max(bucketMaxDurationMs) AS p95DurationMs,
  sum(bucketEstimatedSpanCount) AS estimatedSpanCount
FROM (
  ${completedHourEdges}
  UNION ALL
  ${joinEdges}
)
GROUP BY sourceService, targetService
ORDER BY callCount DESC
LIMIT 200
FORMAT JSON`

	return unsafeCompiledQuery({
		sql,
		rowSchema: ServiceDependenciesOutputSchema,
	})
}

// ---------------------------------------------------------------------------
// Service ↔ service dependencies — scoped to one source service
//
// The service-detail page's Dependencies tab only needs outbound edges for the
// currently-displayed service. The org-wide variant above is kept for the
// global Services map (which renders every edge). This variant pushes the
// `SourceService` filter into both branches so:
//   - the hourly branch reads only rows tagged with this service (cheap), and
//   - the live topology JOIN's left side (Client/Producer spans) shrinks to a
//     single service's outbound spans instead of every span in the org.
// Output shape matches `ServiceDependenciesOutput` so callers can reuse the
// same row-transform code.
// ---------------------------------------------------------------------------

export interface ServiceDependenciesForServiceOpts {
	serviceName: string
	deploymentEnv?: string
}

/**
 * Typesafe-DSL builder for the service-detail page's "Services" dependency
 * panel. Hourly MV branch (sealed buckets) UNION ALL live topology JOIN
 * (in-progress hour), then re-aggregated through `fromUnion()` so the outer
 * SELECT can compute properly-weighted averages across both sources.
 *
 * Returns a `CHQuery`; caller passes `{orgId, startTime, endTime}` to
 * `CH.compile(q, params)` to get the executable SQL.
 */
export function serviceDependenciesForServiceQuery(opts: ServiceDependenciesForServiceOpts) {
	const envFilterMv = (deploymentEnv: CH.Expr<string>) =>
		opts.deploymentEnv ? deploymentEnv.eq(opts.deploymentEnv) : undefined

	// Hourly branch — sealed buckets from the cross-span rollup.
	const hourlyBranch = from(ServiceMapEdgesHourly)
		.select(($) => ({
			sourceService: $.SourceService,
			targetService: $.TargetService,
			bucketCallCount: CH.sum($.CallCount),
			bucketErrorCount: CH.sum($.ErrorCount),
			bucketDurationSumMs: CH.sum($.DurationSumMs),
			bucketMaxDurationMs: CH.max_($.MaxDurationMs),
			// Historical buckets pre-date the SampleRateSum column (it was added
			// later) — fall back to CallCount for those rows so they count as
			// unsampled (degraded but safe).
			bucketEstimatedSpanCount: CH.sum(
				CH.if_($.SampleRateSum.gt(0), $.SampleRateSum, _toFloat64($.CallCount)),
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.SourceService.eq(opts.serviceName),
			$.Hour.gte(CH.toStartOfHour(CH.toDateTime(param.dateTime("startTime")))),
			$.Hour.lt(CH.toStartOfHour(CH.toDateTime(param.dateTime("endTime")))),
			envFilterMv($.DeploymentEnv),
		])
		.groupBy("sourceService", "targetService")

	// Live topology JOIN for the in-progress hour only — the rollup hasn't
	// sealed this hour yet. Mirrors the all-orgs `serviceMapEdgeJoinSQL`
	// helper used by the rollup, but pushes `ServiceName = ?` into the parent
	// subquery so the JOIN's left side shrinks to one service's outbound spans.
	const parentSpans = from(ServiceMapSpans)
		.select(($) => ({
			TraceId: $.TraceId,
			SpanId: $.SpanId,
			ServiceName: $.ServiceName,
			Timestamp: $.Timestamp,
		}))
		.where(($) => [
			$.SpanKind.in_("Client", "Producer"),
			$.Timestamp.gte(CH.toStartOfHour(CH.toDateTime(param.dateTime("endTime")))),
			$.Timestamp.lt(param.dateTime("endTime")),
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			envFilterMv($.DeploymentEnv),
		])

	const childSpans = from(ServiceMapChildren)
		.select(($) => ({
			TraceId: $.TraceId,
			ParentSpanId: $.ParentSpanId,
			ServiceName: $.ServiceName,
			Duration: $.Duration,
			StatusCode: $.StatusCode,
			TraceState: $.TraceState,
		}))
		.where(($) => [
			$.Timestamp.gte(CH.toStartOfHour(CH.toDateTime(param.dateTime("endTime")))),
			$.Timestamp.lt(param.dateTime("endTime")),
			$.OrgId.eq(param.string("orgId")),
			envFilterMv($.DeploymentEnv),
		])

	// Sample-weight expression: `1 / (1 - acceptanceProbability)` for spans
	// carrying a `th:` TraceState threshold, else `1.0` (unsampled). The bit
	// math is intentionally raw — these CH functions (reinterpret/unhex/
	// rightPad/pow/reverse/greatest) aren't worth promoting to first-class
	// DSL helpers for a single call site.
	const sampleWeightExpr = CH.multiIf(
		[
			[
				_matchRegex(CH.rawExpr<string>("c.TraceState"), "th:[0-9a-f]+"),
				CH.rawExpr<number>(
					"1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001)",
				),
			],
		],
		CH.rawExpr<number>("1.0"),
	)

	// In a join, the main subquery's columns are auto-qualified with its alias
	// (`p.ServiceName`), and joined columns are reached via `$.<alias>.Column`.
	const liveJoinBranch = fromQuery(parentSpans, "p")
		.innerJoinQuery(childSpans, "c", (p, c) =>
			p.SpanId.eq(c.ParentSpanId).and(p.TraceId.eq(c.TraceId)),
		)
		.select(($) => ({
			sourceService: $.ServiceName,
			targetService: $.c.ServiceName,
			bucketCallCount: CH.count(),
			bucketErrorCount: CH.countIf($.c.StatusCode.eq("Error")),
			bucketDurationSumMs: CH.sum($.c.Duration.div(1000000)),
			bucketMaxDurationMs: CH.max_($.c.Duration.div(1000000)),
			bucketEstimatedSpanCount: CH.sum(sampleWeightExpr),
		}))
		.where(($) => [$.ServiceName.neq($.c.ServiceName)])
		.groupBy("sourceService", "targetService")

	// Outer wrap: re-aggregate across both branches so avg duration uses
	// branch-summed numerators/denominators (avoids averaging averages). With
	// no further joins, columns from the union are accessed bare.
	return fromUnion(unionAll(hourlyBranch, liveJoinBranch), "edges")
		.select(($) => ({
			sourceService: $.sourceService,
			targetService: $.targetService,
			callCount: CH.sum($.bucketCallCount),
			errorCount: CH.sum($.bucketErrorCount),
			avgDurationMs: CH.sum($.bucketDurationSumMs).div(
				CH.nullIf(CH.sum($.bucketCallCount), CH.lit(0)),
			),
			p95DurationMs: CH.max_($.bucketMaxDurationMs),
			estimatedSpanCount: CH.sum($.bucketEstimatedSpanCount),
		}))
		.groupBy("sourceService", "targetService")
		.orderBy(["callCount", "desc"])
		.limit(200)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Service ↔ database edges
//
// Surfaces DB calls (Client/Producer spans with `db.system.name` set) as a separate
// dependency relation so the service map can reify databases as nodes.
// One row per (sourceService, dbSystem).
//
// Reads pre-aggregated hourly buckets from `service_map_db_edges_hourly`
// (populated by `service_map_db_edges_hourly_mv`), and unions in the trailing
// hour from raw `traces` so the most recent in-flight bucket is included even
// before the MV finalizes it. Mirrors the dual-source pattern used by
// `serviceDependenciesSQL` for `service_map_edges_hourly`.
// ---------------------------------------------------------------------------

export interface ServiceDbEdgesOpts {
	deploymentEnv?: string
}

export interface ServiceDbEdgesOutput {
	readonly sourceService: string
	readonly dbSystem: string
	readonly callCount: number
	readonly errorCount: number
	readonly avgDurationMs: number
	readonly p95DurationMs: number
	readonly estimatedSpanCount: number
}

const ServiceDbEdgesOutputSchema: CompiledQueryRowSchema<ServiceDbEdgesOutput> = Schema.Struct({
	sourceService: Schema.String,
	dbSystem: Schema.String,
	callCount: CHNumber,
	errorCount: CHNumber,
	avgDurationMs: CHNumber,
	p95DurationMs: CHNumber,
	estimatedSpanCount: CHNumber,
})

export function serviceDbEdgesSQL(
	opts: ServiceDbEdgesOpts,
	params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ServiceDbEdgesOutput> {
	const esc = escapeClickHouseString
	const envFilterMv = opts.deploymentEnv
		? `AND DeploymentEnv = '${esc(opts.deploymentEnv)}'`
		: ""
	const envFilterRaw = opts.deploymentEnv
		? `AND ResourceAttributes['deployment.environment'] = '${esc(opts.deploymentEnv)}'`
		: ""

	// Inner branches expose `bucket*` aliases so the outer `sum(...) AS callCount`
	// can't collide with an inner `sum(CallCount) AS callCount` — same fix as
	// `serviceDependenciesSQL` for the same nested-aggregate optimizer error.
	// Historical buckets that pre-date the SampleRateSum column have it set to
	// 0, so we fall back to CallCount per-row (treats those buckets as
	// unsampled — degraded but safe).
	const hourlyEdges = `SELECT
      ServiceName AS sourceService,
      DbSystem AS dbSystem,
      sum(CallCount) AS bucketCallCount,
      sum(ErrorCount) AS bucketErrorCount,
      sum(DurationSumMs) AS bucketDurationSumMs,
      max(MaxDurationMs) AS bucketMaxDurationMs,
      sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount
    FROM service_map_db_edges_hourly
    WHERE OrgId = '${esc(params.orgId)}'
      AND Hour >= toStartOfHour(toDateTime('${esc(params.startTime)}'))
      AND Hour < toStartOfHour(toDateTime('${esc(params.endTime)}'))
      AND DbSystem != ''
      ${envFilterMv}
    GROUP BY sourceService, dbSystem`

	// Raw fallback for the in-progress hour only (the MV branch stops at
	// `toStartOfHour(endTime)`). Reads per-row `SampleRate` directly so no
	// inline weight math is needed. Carries `bucketDurationSumMs` separately
	// so the outer can do a properly-weighted average.
	const recentEdges = `SELECT
      ServiceName AS sourceService,
      SpanAttributes['db.system.name'] AS dbSystem,
      count() AS bucketCallCount,
      countIf(StatusCode = 'Error') AS bucketErrorCount,
      sum(Duration / 1000000) AS bucketDurationSumMs,
      max(Duration / 1000000) AS bucketMaxDurationMs,
      sum(SampleRate) AS bucketEstimatedSpanCount
    FROM traces
    WHERE OrgId = '${esc(params.orgId)}'
      AND Timestamp >= toStartOfHour(toDateTime('${esc(params.endTime)}'))
      AND Timestamp <= '${esc(params.endTime)}'
      AND SpanKind IN ('Client', 'Producer')
      AND SpanAttributes['db.system.name'] != ''
      AND ServiceName != ''
      ${envFilterRaw}
    GROUP BY sourceService, dbSystem`

	const sql = `SELECT
  sourceService,
  dbSystem,
  sum(bucketCallCount) AS callCount,
  sum(bucketErrorCount) AS errorCount,
  sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
  max(bucketMaxDurationMs) AS p95DurationMs,
  sum(bucketEstimatedSpanCount) AS estimatedSpanCount
FROM (
  ${hourlyEdges}
  UNION ALL
  ${recentEdges}
)
GROUP BY sourceService, dbSystem
ORDER BY callCount DESC
LIMIT 200
FORMAT JSON`

	return unsafeCompiledQuery({
		sql,
		rowSchema: ServiceDbEdgesOutputSchema,
	})
}

// ---------------------------------------------------------------------------
// Service ↔ database edges — scoped to one source service
//
// Same shape as `serviceDbEdgesSQL` but pre-filters both branches by
// `ServiceName = ?`. Mirrors the `serviceExternalEdgesSQL` pattern (which is
// already service-scoped).
// ---------------------------------------------------------------------------

export interface ServiceDbEdgesForServiceOpts {
	serviceName: string
	deploymentEnv?: string
}

/**
 * Typesafe-DSL builder for the service-detail page's "Databases" dependency
 * panel. Same dual-source pattern as `serviceDependenciesForServiceQuery` —
 * hourly MV + raw-traces fallback — but no topology JOIN (DB system is
 * already on the parent span as `db.system.name`).
 */
export function serviceDbEdgesForServiceQuery(opts: ServiceDbEdgesForServiceOpts) {
	const envFilterMv = (deploymentEnv: CH.Expr<string>) =>
		opts.deploymentEnv ? deploymentEnv.eq(opts.deploymentEnv) : undefined
	const envFilterRaw = (resourceAttributes: CH.ColumnRef<"ResourceAttributes", any>) =>
		opts.deploymentEnv
			? resourceAttributes.get("deployment.environment").eq(opts.deploymentEnv)
			: undefined

	// Hourly branch — sealed buckets from service_map_db_edges_hourly_mv.
	const hourlyBranch = from(ServiceMapDbEdgesHourly)
		.select(($) => ({
			sourceService: $.ServiceName,
			dbSystem: $.DbSystem,
			bucketCallCount: CH.sum($.CallCount),
			bucketErrorCount: CH.sum($.ErrorCount),
			bucketDurationSumMs: CH.sum($.DurationSumMs),
			bucketMaxDurationMs: CH.max_($.MaxDurationMs),
			bucketEstimatedSpanCount: CH.sum(
				CH.if_($.SampleRateSum.gt(0), $.SampleRateSum, _toFloat64($.CallCount)),
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			$.Hour.gte(CH.toStartOfHour(CH.toDateTime(param.dateTime("startTime")))),
			$.Hour.lt(CH.toStartOfHour(CH.toDateTime(param.dateTime("endTime")))),
			$.DbSystem.neq(""),
			envFilterMv($.DeploymentEnv),
		])
		.groupBy("sourceService", "dbSystem")

	// Raw fallback for the in-progress hour only. `Traces.SampleRate` is a
	// per-row materialized column (no inline weight math needed), and the
	// untyped Output cast below mirrors the column types on the hourly
	// branch so the union's `Output` shape stays consistent.
	const recentBranch = from(Traces)
		.select(($) => ({
			sourceService: $.ServiceName,
			dbSystem: $.SpanAttributes.get("db.system.name"),
			bucketCallCount: CH.count(),
			bucketErrorCount: CH.countIf($.StatusCode.eq("Error")),
			bucketDurationSumMs: CH.sum($.Duration.div(1000000)),
			bucketMaxDurationMs: CH.max_($.Duration.div(1000000)),
			bucketEstimatedSpanCount: CH.sum($.SampleRate),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			$.Timestamp.gte(CH.toStartOfHour(CH.toDateTime(param.dateTime("endTime")))),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.SpanKind.in_("Client", "Producer"),
			$.SpanAttributes.get("db.system.name").neq(""),
			envFilterRaw($.ResourceAttributes),
		])
		.groupBy("sourceService", "dbSystem")

	return fromUnion(unionAll(hourlyBranch, recentBranch), "edges")
		.select(($) => ({
			sourceService: $.sourceService,
			dbSystem: $.dbSystem,
			callCount: CH.sum($.bucketCallCount),
			errorCount: CH.sum($.bucketErrorCount),
			avgDurationMs: CH.sum($.bucketDurationSumMs).div(
				CH.nullIf(CH.sum($.bucketCallCount), CH.lit(0)),
			),
			p95DurationMs: CH.max_($.bucketMaxDurationMs),
			estimatedSpanCount: CH.sum($.bucketEstimatedSpanCount),
		}))
		.groupBy("sourceService", "dbSystem")
		.orderBy(["callCount", "desc"])
		.limit(200)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Service-map database query summaries
//
// Selected database drill-down. This intentionally reads raw `traces` for now
// so the panel can show true P50/P95 latency and top query shapes without a
// schema migration. If this becomes a hot always-on dashboard path, move the
// same dimensions to an hourly TDigest rollup.
// ---------------------------------------------------------------------------

export interface ServiceDbQuerySummaryParams {
	readonly orgId: string
	readonly dbSystem: string
	readonly startTime: string
	readonly endTime: string
	readonly sourceService?: string
	readonly deploymentEnv?: string
	readonly bucketSeconds?: number
	readonly topN?: number
}

export interface ServiceDbQuerySummaryOutput {
	readonly queryCount: number
	readonly estimatedQueryCount: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly errorRate: number
	readonly avgDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly activeServiceCount: number
}

const ServiceDbQuerySummaryOutputSchema: CompiledQueryRowSchema<ServiceDbQuerySummaryOutput> =
	Schema.Struct({
		queryCount: CHNumber,
		estimatedQueryCount: CHNumber,
		errorCount: CHNumber,
		estimatedErrorCount: CHNumber,
		errorRate: CHNumber,
		avgDurationMs: CHNumber,
		p50DurationMs: CHNumber,
		p95DurationMs: CHNumber,
		activeServiceCount: CHNumber,
	})

export interface ServiceDbQueryTimeseriesOutput {
	readonly bucket: string
	readonly queryCount: number
	readonly estimatedQueryCount: number
	readonly errorCount: number
	readonly errorRate: number
	readonly avgDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
}

const ServiceDbQueryTimeseriesOutputSchema: CompiledQueryRowSchema<ServiceDbQueryTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		queryCount: CHNumber,
		estimatedQueryCount: CHNumber,
		errorCount: CHNumber,
		errorRate: CHNumber,
		avgDurationMs: CHNumber,
		p50DurationMs: CHNumber,
		p95DurationMs: CHNumber,
	})

export interface ServiceDbTopQueryOutput {
	readonly queryKey: string
	readonly queryLabel: string
	readonly sampleStatement: string
	readonly sampleService: string
	readonly serviceCount: number
	readonly queryCount: number
	readonly estimatedQueryCount: number
	readonly errorCount: number
	readonly errorRate: number
	readonly avgDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly lastSeen: string
}

const ServiceDbTopQueryOutputSchema: CompiledQueryRowSchema<ServiceDbTopQueryOutput> = Schema.Struct({
	queryKey: Schema.String,
	queryLabel: Schema.String,
	sampleStatement: Schema.String,
	sampleService: Schema.String,
	serviceCount: CHNumber,
	queryCount: CHNumber,
	estimatedQueryCount: CHNumber,
	errorCount: CHNumber,
	errorRate: CHNumber,
	avgDurationMs: CHNumber,
	p50DurationMs: CHNumber,
	p95DurationMs: CHNumber,
	lastSeen: Schema.String,
})

const DB_SYSTEM_ATTR_EXPR =
	"coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system'])"

const DB_QUERY_LABEL_EXPR = `coalesce(
  nullIf(SpanAttributes['db.query.summary'], ''),
  nullIf(SpanAttributes['db.operation.name'], ''),
  nullIf(SpanAttributes['db.operation'], ''),
  nullIf(SpanAttributes['db.statement'], ''),
  SpanName
)`

const DB_QUERY_KEY_EXPR = `coalesce(
  nullIf(SpanAttributes['db.statement.fingerprint'], ''),
  toString(cityHash64(${DB_QUERY_LABEL_EXPR}))
)`

const DB_DURATION_QUANTILES_EXPR =
	"quantilesTDigestWeighted(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0)))"

const clampBucketSeconds = (value: number | undefined): number => {
	if (!Number.isFinite(value)) return 3600
	const rounded = Math.round(value ?? 3600)
	return Math.min(24 * 60 * 60, Math.max(60, rounded))
}

const clampTopN = (value: number | undefined): number => {
	if (!Number.isFinite(value)) return 10
	const rounded = Math.round(value ?? 10)
	return Math.min(50, Math.max(1, rounded))
}

function serviceDbRawWhere(params: ServiceDbQuerySummaryParams): string {
	const esc = escapeClickHouseString
	const sourceServiceFilter = params.sourceService
		? `AND ServiceName = '${esc(params.sourceService)}'`
		: ""
	const envFilter = params.deploymentEnv
		? `AND ResourceAttributes['deployment.environment'] = '${esc(params.deploymentEnv)}'`
		: ""

	return `OrgId = '${esc(params.orgId)}'
      AND Timestamp >= toDateTime('${esc(params.startTime)}')
      AND Timestamp <= toDateTime('${esc(params.endTime)}')
      AND SpanKind IN ('Client', 'Producer')
      AND ServiceName != ''
      AND ${DB_SYSTEM_ATTR_EXPR} = '${esc(params.dbSystem)}'
      ${sourceServiceFilter}
      ${envFilter}`
}

export function serviceDbQuerySummarySQL(
	params: ServiceDbQuerySummaryParams,
): CompiledQuery<ServiceDbQuerySummaryOutput> {
	const sql = `SELECT
  count() AS queryCount,
  sum(SampleRate) AS estimatedQueryCount,
  countIf(StatusCode = 'Error') AS errorCount,
  sumIf(SampleRate, StatusCode = 'Error') AS estimatedErrorCount,
  if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
  if(sum(SampleRate) > 0, sum(toFloat64(Duration) * SampleRate) / sum(SampleRate) / 1000000, 0) AS avgDurationMs,
  if(count() > 0, arrayElement(${DB_DURATION_QUANTILES_EXPR}, 1) / 1000000, 0) AS p50DurationMs,
  if(count() > 0, arrayElement(${DB_DURATION_QUANTILES_EXPR}, 2) / 1000000, 0) AS p95DurationMs,
  uniq(ServiceName) AS activeServiceCount
FROM traces
WHERE ${serviceDbRawWhere(params)}
FORMAT JSON`

	return unsafeCompiledQuery({
		sql,
		rowSchema: ServiceDbQuerySummaryOutputSchema,
	})
}

export function serviceDbQueryTimeseriesSQL(
	params: ServiceDbQuerySummaryParams,
): CompiledQuery<ServiceDbQueryTimeseriesOutput> {
	const bucketSeconds = clampBucketSeconds(params.bucketSeconds)
	const sql = `SELECT
  toStartOfInterval(Timestamp, INTERVAL ${bucketSeconds} SECOND) AS bucket,
  count() AS queryCount,
  sum(SampleRate) AS estimatedQueryCount,
  countIf(StatusCode = 'Error') AS errorCount,
  if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
  if(sum(SampleRate) > 0, sum(toFloat64(Duration) * SampleRate) / sum(SampleRate) / 1000000, 0) AS avgDurationMs,
  if(count() > 0, arrayElement(${DB_DURATION_QUANTILES_EXPR}, 1) / 1000000, 0) AS p50DurationMs,
  if(count() > 0, arrayElement(${DB_DURATION_QUANTILES_EXPR}, 2) / 1000000, 0) AS p95DurationMs
FROM traces
WHERE ${serviceDbRawWhere(params)}
GROUP BY bucket
ORDER BY bucket ASC
LIMIT 2000
FORMAT JSON`

	return unsafeCompiledQuery({
		sql,
		rowSchema: ServiceDbQueryTimeseriesOutputSchema,
	})
}

export function serviceDbTopQueriesSQL(
	params: ServiceDbQuerySummaryParams,
): CompiledQuery<ServiceDbTopQueryOutput> {
	const topN = clampTopN(params.topN)
	const sql = `SELECT
  QueryKey AS queryKey,
  any(QueryLabel) AS queryLabel,
  anyIf(Statement, Statement != '') AS sampleStatement,
  any(ServiceName) AS sampleService,
  uniq(ServiceName) AS serviceCount,
  count() AS queryCount,
  sum(SampleRate) AS estimatedQueryCount,
  countIf(StatusCode = 'Error') AS errorCount,
  if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
  if(sum(SampleRate) > 0, sum(toFloat64(Duration) * SampleRate) / sum(SampleRate) / 1000000, 0) AS avgDurationMs,
  if(count() > 0, arrayElement(${DB_DURATION_QUANTILES_EXPR}, 1) / 1000000, 0) AS p50DurationMs,
  if(count() > 0, arrayElement(${DB_DURATION_QUANTILES_EXPR}, 2) / 1000000, 0) AS p95DurationMs,
  max(Timestamp) AS lastSeen
FROM (
  SELECT
    ServiceName,
    Timestamp,
    Duration,
    StatusCode,
    SampleRate,
    ${DB_QUERY_KEY_EXPR} AS QueryKey,
    substring(${DB_QUERY_LABEL_EXPR}, 1, 220) AS QueryLabel,
    SpanAttributes['db.statement'] AS Statement
  FROM traces
  WHERE ${serviceDbRawWhere(params)}
)
GROUP BY queryKey
ORDER BY estimatedQueryCount DESC
LIMIT ${topN}
FORMAT JSON`

	return unsafeCompiledQuery({
		sql,
		rowSchema: ServiceDbTopQueryOutputSchema,
	})
}

// ---------------------------------------------------------------------------
// Service ↔ external target edges (http / messaging / rpc)
//
// Surfaces non-DB Client/Producer outbound calls — HTTP endpoints, message
// queues, RPC targets — as a unified inventory for the service-detail page's
// "Dependencies" tab. Mirrors the DB-edges pattern: hourly MV (sealed buckets)
// UNION ALL with raw-traces fallback (in-progress hour), then de-duplicated
// against `service_address_resolutions_hourly` so HTTP targets whose address
// resolves to a known internal service (in the same window) drop out — those
// already appear under "Services" via `serviceDependenciesSQL`.
// ---------------------------------------------------------------------------

export interface ServiceExternalEdgesOpts {
	deploymentEnv?: string
	serviceName: string
}

export interface ServiceExternalEdgesOutput {
	readonly sourceService: string
	readonly targetType: "http" | "messaging" | "rpc"
	readonly targetSystem: string
	readonly targetName: string
	readonly callCount: number
	readonly errorCount: number
	readonly avgDurationMs: number
	readonly p95DurationMs: number
	readonly estimatedSpanCount: number
}

const ServiceExternalEdgesOutputSchema: CompiledQueryRowSchema<ServiceExternalEdgesOutput> =
	Schema.Struct({
		sourceService: Schema.String,
		targetType: Schema.Literals(["http", "messaging", "rpc"]),
		targetSystem: Schema.String,
		targetName: Schema.String,
		callCount: CHNumber,
		errorCount: CHNumber,
		avgDurationMs: CHNumber,
		p95DurationMs: CHNumber,
		estimatedSpanCount: CHNumber,
	})

export function serviceExternalEdgesSQL(
	opts: ServiceExternalEdgesOpts,
	params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ServiceExternalEdgesOutput> {
	const esc = escapeClickHouseString
	const envFilterMv = opts.deploymentEnv
		? `AND DeploymentEnv = '${esc(opts.deploymentEnv)}'`
		: ""
	const envFilterRaw = opts.deploymentEnv
		? `AND ResourceAttributes['deployment.environment'] = '${esc(opts.deploymentEnv)}'`
		: ""
	const envFilterRes = opts.deploymentEnv
		? `AND DeploymentEnv = '${esc(opts.deploymentEnv)}'`
		: ""

	// Hourly branch: sealed buckets from the MV-fed table. Carries
	// `bucket*` aliases so the outer aggregate can't collide with inner ones
	// (same nested-aggregate optimizer gotcha as `serviceDbEdgesSQL`).
	const hourlyEdges = `SELECT
      ServiceName AS sourceService,
      TargetType AS targetType,
      TargetSystem AS targetSystem,
      TargetName AS targetName,
      sum(CallCount) AS bucketCallCount,
      sum(ErrorCount) AS bucketErrorCount,
      sum(DurationSumMs) AS bucketDurationSumMs,
      max(MaxDurationMs) AS bucketMaxDurationMs,
      sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount
    FROM service_external_edges_hourly
    WHERE OrgId = '${esc(params.orgId)}'
      AND ServiceName = '${esc(opts.serviceName)}'
      AND Hour >= toStartOfHour(toDateTime('${esc(params.startTime)}'))
      AND Hour < toStartOfHour(toDateTime('${esc(params.endTime)}'))
      AND TargetName != ''
      ${envFilterMv}
    GROUP BY sourceService, targetType, targetSystem, targetName`

	// Recent branch: raw `traces` for the in-progress hour only. Mirrors the
	// `multiIf` precedence used by the MV (messaging > rpc > http) so the
	// two branches produce identical row shapes for the same span.
	const recentEdges = `SELECT
      ServiceName AS sourceService,
      multiIf(
        SpanAttributes['messaging.destination'] != '' OR SpanAttributes['messaging.system'] != '', 'messaging',
        SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '', 'rpc',
        'http'
      ) AS targetType,
      multiIf(
        SpanAttributes['messaging.destination'] != '' OR SpanAttributes['messaging.system'] != '', SpanAttributes['messaging.system'],
        SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '', SpanAttributes['rpc.system'],
        ''
      ) AS targetSystem,
      multiIf(
        SpanAttributes['messaging.destination'] != '' OR SpanAttributes['messaging.system'] != '',
          if(SpanAttributes['messaging.destination'] != '', SpanAttributes['messaging.destination'], SpanAttributes['messaging.system']),
        SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '',
          if(SpanAttributes['rpc.service'] != '', SpanAttributes['rpc.service'], SpanAttributes['rpc.system']),
        if(SpanAttributes['server.address'] != '',
          SpanAttributes['server.address'],
          if(SpanAttributes['http.host'] != '',
            SpanAttributes['http.host'],
            SpanAttributes['url.authority']))
      ) AS targetName,
      count() AS bucketCallCount,
      countIf(StatusCode = 'Error') AS bucketErrorCount,
      sum(Duration / 1000000) AS bucketDurationSumMs,
      max(Duration / 1000000) AS bucketMaxDurationMs,
      sum(SampleRate) AS bucketEstimatedSpanCount
    FROM traces
    WHERE OrgId = '${esc(params.orgId)}'
      AND ServiceName = '${esc(opts.serviceName)}'
      AND Timestamp >= toStartOfHour(toDateTime('${esc(params.endTime)}'))
      AND Timestamp <= '${esc(params.endTime)}'
      AND SpanKind IN ('Client', 'Producer')
      AND SpanAttributes['db.system.name'] = ''
      AND (
           SpanAttributes['server.address'] != ''
        OR SpanAttributes['http.host'] != ''
        OR SpanAttributes['url.authority'] != ''
        OR SpanAttributes['messaging.destination'] != ''
        OR SpanAttributes['messaging.system'] != ''
        OR SpanAttributes['rpc.service'] != ''
        OR SpanAttributes['rpc.system'] != ''
      )
      ${envFilterRaw}
    GROUP BY sourceService, targetType, targetSystem, targetName
    HAVING targetName != ''`

	// Internal-service overlap suppression: drop HTTP rows whose `targetName`
	// resolves to a known internal service in the same window. Messaging and
	// RPC pass through unchanged (queues/RPC services are never the same
	// identity as an internal service name). Scoped to `[startHour, endHour]`
	// so we don't anti-join against ancient resolutions.
	const sql = `SELECT
  sourceService,
  targetType,
  targetSystem,
  targetName,
  sum(bucketCallCount) AS callCount,
  sum(bucketErrorCount) AS errorCount,
  sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
  max(bucketMaxDurationMs) AS p95DurationMs,
  sum(bucketEstimatedSpanCount) AS estimatedSpanCount
FROM (
  ${hourlyEdges}
  UNION ALL
  ${recentEdges}
) AS edges
WHERE NOT (
  targetType = 'http'
  AND targetName IN (
    SELECT DISTINCT ParentServerAddress
    FROM service_address_resolutions_hourly
    WHERE OrgId = '${esc(params.orgId)}'
      AND SourceService = '${esc(opts.serviceName)}'
      AND Hour >= toStartOfHour(toDateTime('${esc(params.startTime)}'))
      AND Hour < toStartOfHour(toDateTime('${esc(params.endTime)}'))
      AND ParentServerAddress != ''
      ${envFilterRes}
  )
)
GROUP BY sourceService, targetType, targetSystem, targetName
ORDER BY callCount DESC
LIMIT 200
FORMAT JSON`

	return unsafeCompiledQuery({
		sql,
		rowSchema: ServiceExternalEdgesOutputSchema,
	})
}

// ---------------------------------------------------------------------------
// Service hosting platform
//
// Per-service rollup of the OTel resource attributes that identify where a
// service runs. The caller derives a single `Platform` label from these raw
// values (see apps/web/src/api/tinybird/service-map.ts).
//
// Reads from `service_platforms_hourly` (populated by
// `service_platforms_hourly_mv`). The MV uses SimpleAggregateFunction("max")
// on each attribute string, so empty strings sort first and any non-empty
// value wins on merge — exactly the "did any span in this window carry this
// attribute" semantics the platform classifier needs. `k8s.pod.name` /
// `k8s.deployment.name` are required for the kubernetes signal because
// `k8s.cluster.name` can leak onto in-transit spans via the otel-gateway.
// ---------------------------------------------------------------------------

export interface ServicePlatformsOpts {
	deploymentEnv?: string
}

export interface ServicePlatformsOutput {
	readonly serviceName: string
	readonly k8sCluster: string
	readonly k8sPodName: string
	readonly k8sDeploymentName: string
	readonly cloudPlatform: string
	readonly cloudProvider: string
	readonly faasName: string
	readonly mapleSdkType: string
	readonly processRuntimeName: string
}

const ServicePlatformsOutputSchema: CompiledQueryRowSchema<ServicePlatformsOutput> = Schema.Struct({
	serviceName: Schema.String,
	k8sCluster: Schema.String,
	k8sPodName: Schema.String,
	k8sDeploymentName: Schema.String,
	cloudPlatform: Schema.String,
	cloudProvider: Schema.String,
	faasName: Schema.String,
	mapleSdkType: Schema.String,
	processRuntimeName: Schema.String,
})

export function servicePlatformsSQL(
	opts: ServicePlatformsOpts,
	params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ServicePlatformsOutput> {
	const query = from(ServicePlatformsHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			// `max()` on a SimpleAggregateFunction(max, String) column merges
			// non-empty strings to win over empty ones — the "did any span in
			// this window carry this attribute" semantics the platform
			// classifier needs.
			k8sCluster: CH.max_($.K8sCluster),
			k8sPodName: CH.max_($.K8sPodName),
			k8sDeploymentName: CH.max_($.K8sDeploymentName),
			cloudPlatform: CH.max_($.CloudPlatform),
			cloudProvider: CH.max_($.CloudProvider),
			faasName: CH.max_($.FaasName),
			mapleSdkType: CH.max_($.MapleSdkType),
			processRuntimeName: CH.max_($.ProcessRuntimeName),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(CH.toStartOfHour(CH.toDateTime(param.dateTime("startTime")))),
			$.Hour.lte(param.dateTime("endTime")),
			$.ServiceName.neq(""),
			opts.deploymentEnv ? $.DeploymentEnv.eq(opts.deploymentEnv) : undefined,
		])
		.groupBy("serviceName")
		.limit(500)
		.format("JSON")

	const { sql } = compileCH(query, {
		orgId: params.orgId,
		startTime: params.startTime,
		endTime: params.endTime,
	})

	return unsafeCompiledQuery({
		sql,
		rowSchema: ServicePlatformsOutputSchema,
	})
}
