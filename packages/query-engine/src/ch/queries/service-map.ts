// ---------------------------------------------------------------------------
// Typed Service Map Queries
//
// Raw SQL builder for service dependency edges (multi-table JOIN + UNION ALL).
// ---------------------------------------------------------------------------

import { escapeClickHouseString } from "../../sql/sql-fragment"
import { compileCH, type CompiledQuery } from "../compile"
import * as CH from "../expr"
import { param } from "../param"
import { from } from "../query"
import { ServicePlatformsHourly } from "../tables"

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
}): string {
	const esc = escapeClickHouseString
	const orgFilter = params.orgId ? `AND OrgId = '${esc(params.orgId)}'` : ""
	const envFilter = params.deploymentEnv
		? `AND DeploymentEnv = '${esc(params.deploymentEnv)}'`
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

	return {
		sql,
		castRows: (rows) => rows as unknown as ReadonlyArray<ServiceDependenciesOutput>,
	}
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

	return {
		sql,
		castRows: (rows) => rows as unknown as ReadonlyArray<ServiceDbEdgesOutput>,
	}
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
      AND Hour <= toDateTime('${esc(params.endTime)}')
      AND ParentServerAddress != ''
      ${envFilterRes}
  )
)
GROUP BY sourceService, targetType, targetSystem, targetName
ORDER BY callCount DESC
LIMIT 200
FORMAT JSON`

	return {
		sql,
		castRows: (rows) => rows as unknown as ReadonlyArray<ServiceExternalEdgesOutput>,
	}
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
			$.Hour.gte(CH.toStartOfHour(param.dateTime("startTime"))),
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

	return {
		sql,
		castRows: (rows) => rows as unknown as ReadonlyArray<ServicePlatformsOutput>,
	}
}
