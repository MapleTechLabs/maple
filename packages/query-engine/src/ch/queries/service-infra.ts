// Service ↔ Infrastructure join
//
// Joins OTel `ServiceName` to k8s workload identity (`k8s.deployment.name` /
// `k8s.statefulset.name` / `k8s.daemonset.name` + `k8s.namespace.name`), then
// enriches with pod count and CPU/memory limit utilization aggregated from the
// matching k8s.pod.* gauges in metrics_gauge.
//
// Workload identity is read from the pre-aggregated `service_platforms_hourly`
// MV (one row per service/env/hour) rather than scanning raw `traces` — the MV
// uses `max()` per attribute, so it yields the dominant workload per service.
// A service genuinely spread across multiple deployments shows its dominant
// one. Services with no k8s context produce no rows, which the UI renders as
// an empty Infrastructure tab.
//
// The JOIN keys on kind/name/namespace only. `k8s.cluster.name` is deliberately
// NOT a key: it's tagged on the kubeletstats pod gauges but never on spans (the
// `k8sattributes` processor doesn't set it), so joining on it dropped every row
// and pod counts always read 0. Cluster is sourced from the metrics side for
// display only.
//
// The span-side k8s attributes are only present when the agent's `k8sattributes`
// processor has tagged the spans — see deploy/k8s-infra/values.yaml.
//
// Built with the ClickHouse query-builder DSL (a `fromQuery(...).leftJoinQuery`
// over two grouped subqueries), then compiled to SQL — no hand-written SQL.

import { Schema, Effect } from "effect"
import { compile, type CompiledQuery, type CompiledQueryRowSchema } from "@maple-dev/effect-orm/clickhouse"
import { rawCompiledQuery } from "../raw-sql"
import * as CH from "@maple-dev/effect-orm/expr"
import { param } from "@maple-dev/effect-orm/clickhouse"
import { from, fromQuery } from "@maple-dev/effect-orm/clickhouse"
import { MetricsGauge, ServicePlatformsHourly, orgIdParam, utcSecondsParam } from "../tables"
import { CHNumber } from "../schema"
import type { QueryBuilderError } from "@maple-dev/effect-orm/clickhouse"
import type { OrgId } from "@maple/domain"
import {
	SERVICE_RUNTIME_MARKERS,
	runtimeMetricServiceNames,
	serviceRuntimeKindOfMarker,
	type ServiceRuntimeKindId,
	tracedServiceOfRuntime,
} from "@maple/domain/service-runtimes"

export interface ServiceWorkloadsOpts {
	services: ReadonlyArray<string>
}

export interface ServiceWorkloadsOutput {
	readonly serviceName: string
	readonly workloadKind: "deployment" | "statefulset" | "daemonset" | "unknown"
	readonly workloadName: string
	readonly namespace: string
	readonly clusterName: string
	readonly podCount: number
	readonly avgCpuLimitUtilization: number | null
	readonly avgMemoryLimitUtilization: number | null
}

const ServiceWorkloadsOutputSchema: CompiledQueryRowSchema<ServiceWorkloadsOutput> = Schema.Struct({
	serviceName: Schema.String,
	workloadKind: Schema.Literals(["deployment", "statefulset", "daemonset", "unknown"]),
	workloadName: Schema.String,
	namespace: Schema.String,
	clusterName: Schema.String,
	podCount: CHNumber,
	avgCpuLimitUtilization: Schema.NullOr(CHNumber),
	avgMemoryLimitUtilization: Schema.NullOr(CHNumber),
})

// `IN ()` is invalid SQL, so an empty service list short-circuits to a
// zero-row result with the right column shape.
const EMPTY_WORKLOADS_SQL = `SELECT '' AS serviceName, '' AS workloadKind, '' AS workloadName,
       '' AS namespace, '' AS clusterName,
       toUInt64(0) AS podCount,
       toNullable(toFloat64(0)) AS avgCpuLimitUtilization,
       toNullable(toFloat64(0)) AS avgMemoryLimitUtilization
WHERE 0
FORMAT JSON`

export function serviceWorkloadsSQL(
	opts: ServiceWorkloadsOpts,
	params: { orgId: OrgId; startTime: string; endTime: string },
): Effect.Effect<CompiledQuery<ServiceWorkloadsOutput>, QueryBuilderError> {
	if (opts.services.length === 0) {
		// Reads no table at all (`WHERE 0`), so it cannot cross tenants; it stands
		// in for a scoped call whose service list was empty.
		return Effect.succeed(
			rawCompiledQuery({
				sql: EMPTY_WORKLOADS_SQL,
				reason: "empty-result-stub",
				justification:
					"SELECT of literals with WHERE 0 and no FROM; the builder always emits a FROM, and naming a table this reads no rows from would be worse.",
				tenantScope: "single-tenant",
				rowSchema: ServiceWorkloadsOutputSchema,
			}),
		)
	}

	// Per-service workload identity from the pre-aggregated MV. `max()` over the
	// per-(service, env, hour) winners collapses to the dominant workload, and
	// the multiIf precedence (deployment > statefulset > daemonset) mirrors the
	// classifier used on the metrics side so the JOIN keys line up.
	//
	// Cluster is deliberately NOT projected here: it is sourced from spans, where
	// `k8s.cluster.name` is never tagged (the `k8sattributes` processor doesn't
	// set it), so `K8sCluster` is always ''. The kubeletstats pod gauges DO carry
	// it, so the metrics side below owns clusterName for both the JOIN and display.
	const workloadIdentity = from(ServicePlatformsHourly)
		.select(($) => {
			const deployment = CH.max_($.K8sDeploymentName)
			const statefulSet = CH.max_($.K8sStatefulSetName)
			const daemonSet = CH.max_($.K8sDaemonSetName)
			return {
				serviceName: $.ServiceName,
				workloadKind: CH.multiIf(
					[
						[deployment.neq(""), CH.lit("deployment")],
						[statefulSet.neq(""), CH.lit("statefulset")],
						[daemonSet.neq(""), CH.lit("daemonset")],
					],
					CH.lit("unknown"),
				),
				workloadName: CH.multiIf(
					[
						[deployment.neq(""), deployment],
						[statefulSet.neq(""), statefulSet],
						[daemonSet.neq(""), daemonSet],
					],
					CH.lit(""),
				),
				namespace: CH.max_($.K8sNamespaceName),
			}
		})
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(CH.toStartOfHour(CH.toDateTime(utcSecondsParam("startTime")))),
			$.Hour.lte(utcSecondsParam("endTime")),
			CH.inList($.ServiceName, opts.services),
		])
		.groupBy("serviceName")

	// Pod count + CPU/memory limit utilization per workload, from the k8s.pod.*
	// gauges. Keyed by workload identity (kind/name/namespace) so it LEFT JOINs
	// onto the identity rows above. clusterName is NOT a join key — spans never
	// carry it (see workloadIdentity) — so it's aggregated here purely for
	// display and survives the JOIN as the metrics-side value.
	//
	// `k8s.pod.cpu.usage` is emitted by every pod, so it (not the *_utilization
	// gauges, which require CPU/memory limits to be set) drives uniq(pod.uid).
	// The avgIf aggregates still read their own *_utilization rows from the same
	// scan, returning 0/null when a cluster doesn't set the matching limit.
	const workloadMetrics = from(MetricsGauge)
		.select(($) => {
			const deployment = $.ResourceAttributes.get("k8s.deployment.name")
			const statefulSet = $.ResourceAttributes.get("k8s.statefulset.name")
			const daemonSet = $.ResourceAttributes.get("k8s.daemonset.name")
			return {
				workloadKind: CH.multiIf(
					[
						[deployment.neq(""), CH.lit("deployment")],
						[statefulSet.neq(""), CH.lit("statefulset")],
						[daemonSet.neq(""), CH.lit("daemonset")],
					],
					CH.lit("unknown"),
				),
				workloadName: CH.multiIf(
					[
						[deployment.neq(""), deployment],
						[statefulSet.neq(""), statefulSet],
						[daemonSet.neq(""), daemonSet],
					],
					CH.lit(""),
				),
				namespace: $.ResourceAttributes.get("k8s.namespace.name"),
				clusterName: CH.max_($.ResourceAttributes.get("k8s.cluster.name")),
				podCount: CH.uniq($.ResourceAttributes.get("k8s.pod.uid")),
				avgCpuLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
				avgMemoryLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			}
		})
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			CH.inList($.MetricName, [
				"k8s.pod.cpu.usage",
				"k8s.pod.cpu_limit_utilization",
				"k8s.pod.memory_limit_utilization",
			]),
			$.ResourceAttributes.get("k8s.pod.uid").neq(""),
		])
		.groupBy("workloadKind", "workloadName", "namespace")

	const query = fromQuery(workloadIdentity, "swm")
		.leftJoinQuery(workloadMetrics, "wm", (swm, wm) =>
			swm.workloadKind
				.eq(wm.workloadKind)
				.and(swm.workloadName.eq(wm.workloadName))
				.and(swm.namespace.eq(wm.namespace)),
		)
		.select(($) => ({
			serviceName: $.serviceName,
			workloadKind: $.workloadKind,
			workloadName: $.workloadName,
			namespace: $.namespace,
			// Cluster comes from the metrics side (spans don't carry it). With
			// ClickHouse's default join_use_nulls=0, an unmatched LEFT JOIN row
			// yields '' here, which the non-nullable string schema decodes fine.
			clusterName: $.wm.clusterName,
			// LEFT JOIN ⇒ these are null for services with no pod gauges; the
			// route coerces (`Number(podCount) || 0`, null-checks the averages).
			podCount: $.wm.podCount,
			avgCpuLimitUtilization: $.wm.avgCpuLimitPct,
			avgMemoryLimitUtilization: $.wm.avgMemoryLimitPct,
		}))
		.where(($) => [$.workloadName.neq("")])
		.orderBy(["serviceName", "asc"], ["workloadName", "asc"])
		.limit(500)
		.format("JSON")

	// No top-level `OrgId` predicate here on purpose: the scope is derived from
	// the sources, both of which filter `OrgId` themselves.
	return compile(
		query,
		{
			orgId: params.orgId,
			startTime: params.startTime,
			endTime: params.endTime,
		},
		{ rowSchema: ServiceWorkloadsOutputSchema },
	)
}

// Service ↔ platform runtime: a resource's marker gauge under the service's names, one row per
// resource with the keys its infra page reads. `metrics_gauge` sorts by (OrgId, ServiceName,
// MetricName), so this reads only these services' marker series.

export interface ServiceRuntimesOpts {
	services: ReadonlyArray<string>
}

export interface ServiceRuntimesOutput {
	/** The series' `service.name`; `tracedServiceOfRuntime` maps it to the traced service. */
	readonly metricServiceName: string
	readonly metricName: string
	/** GCP project, AWS account or Cloudflare account. */
	readonly account: string
	readonly region: string
	/** ECS cluster. */
	readonly cluster: string
	readonly railwayServiceId: string
	readonly railwayEnvironmentId: string
	readonly railwayEnvironmentName: string
}

const ServiceRuntimesOutputSchema: CompiledQueryRowSchema<ServiceRuntimesOutput> = Schema.Struct({
	metricServiceName: Schema.String,
	metricName: Schema.String,
	account: Schema.String,
	region: Schema.String,
	cluster: Schema.String,
	railwayServiceId: Schema.String,
	railwayEnvironmentId: Schema.String,
	railwayEnvironmentName: Schema.String,
})

export function serviceRuntimesSQL(
	opts: ServiceRuntimesOpts,
	params: { orgId: OrgId; startTime: string; endTime: string },
): Effect.Effect<CompiledQuery<ServiceRuntimesOutput>, QueryBuilderError> {
	const query = from(MetricsGauge)
		.select(($) => ({
			metricServiceName: $.ServiceName,
			metricName: $.MetricName,
			account: CH.if_(
				$.ResourceAttributes.get("cloud.account.id").neq(""),
				$.ResourceAttributes.get("cloud.account.id"),
				$.ResourceAttributes.get("cloudflare.account.id"),
			),
			region: $.ResourceAttributes.get("cloud.region"),
			cluster: $.Attributes.get("aws.dimension.cluster_name"),
			railwayServiceId: $.ResourceAttributes.get("railway.service.id"),
			railwayEnvironmentId: $.ResourceAttributes.get("railway.environment.id"),
			railwayEnvironmentName: CH.max_($.ResourceAttributes.get("railway.environment.name")),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			CH.inList($.ServiceName, opts.services.flatMap(runtimeMetricServiceNames)),
			CH.inList($.MetricName, SERVICE_RUNTIME_MARKERS),
		])
		.groupBy(
			"metricServiceName",
			"metricName",
			"account",
			"region",
			"cluster",
			"railwayServiceId",
			"railwayEnvironmentId",
		)
		.orderBy(["metricServiceName", "asc"], ["metricName", "asc"])
		// Rows are resources, a few per service; the cap is a backstop, not a page size.
		.limit(10_000)
		.format("JSON")

	return compile(
		query,
		{ orgId: params.orgId, startTime: params.startTime, endTime: params.endTime },
		{ rowSchema: ServiceRuntimesOutputSchema },
	)
}

export interface ServiceRuntimeResource {
	readonly serviceName: string
	readonly kind: ServiceRuntimeKindId
	readonly account: string
	readonly region: string
	readonly cluster: string
	readonly railwayServiceId: string
	readonly railwayEnvironmentId: string
	readonly railwayEnvironmentName: string
}

/**
 * One resource per row of a requested service. A Railway service is one resource per environment,
 * whatever its regions; a `cloudflare-worker/x` series only ever answers for `x`.
 */
export const serviceRuntimeResources = (
	rows: ReadonlyArray<ServiceRuntimesOutput>,
	requested: ReadonlyArray<string>,
): ReadonlyArray<ServiceRuntimeResource> => {
	const isRequested = new Set(requested)
	const resources = rows.flatMap((row) => {
		const kind = serviceRuntimeKindOfMarker(row.metricName)
		const serviceName = tracedServiceOfRuntime(row.metricServiceName)
		if (kind === null || !isRequested.has(serviceName)) return []
		const key =
			kind === "railway"
				? ["railway", serviceName, row.railwayServiceId, row.railwayEnvironmentId].join("|")
				: [kind, row.metricServiceName, row.account, row.region, row.cluster].join("|")
		const resource: ServiceRuntimeResource = {
			serviceName,
			kind,
			account: row.account,
			region: row.region,
			cluster: row.cluster,
			railwayServiceId: row.railwayServiceId,
			railwayEnvironmentId: row.railwayEnvironmentId,
			railwayEnvironmentName: row.railwayEnvironmentName,
		}
		return [[key, resource] as const]
	})
	return Array.from(new Map(resources).values())
}
