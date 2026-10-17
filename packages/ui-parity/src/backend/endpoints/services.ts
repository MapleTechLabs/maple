import { DateTime, Effect, Schema } from "effect"
import {
	CommitSha,
	ServiceApdexRequest,
	ServiceApdexResponse,
	ServiceDependenciesBundleRequest,
	ServiceDependenciesBundleResponse,
	ServiceDetailOverviewRequest,
	ServiceDetailOverviewResponse,
	ServiceHealthBaselineRequest,
	ServiceHealthBaselineResponse,
	ServiceHealthSnapshotRequest,
	ServiceHealthSnapshotResponse,
	ServiceMapBundleRequest,
	ServiceMapBundleResponse,
	ServiceName,
	ServiceOverviewRequest,
	ServiceOverviewResponse,
	ServiceUsageRequest,
	ServiceUsageResponse,
	ServiceWorkloadsRequest,
	ServiceWorkloadsResponse,
} from "@maple/domain/http"
import type { CH } from "@maple/query-engine"
import { Queries } from "@maple/query-engine/registry"
import type { EndpointHandler } from "../../fixtures/dataset.ts"
import type { FixtureWarehouse } from "../warehouse.ts"
import { warehouseEndpoint } from "./run.ts"

/**
 * The service endpoints of `HttpQueryEngineLive` (apps/api/src/routes/internal/query-engine.http.ts):
 * same registry queries, same row shaping, run on the fixture warehouse.
 */

const decodeServiceName = Schema.decodeUnknownSync(ServiceName)
const decodeCommitSha = Schema.decodeUnknownSync(CommitSha)

const toServiceWorkloadRow = (row: CH.ServiceWorkloadsOutput) => ({
	serviceName: decodeServiceName(row.serviceName),
	workloadKind: row.workloadKind,
	workloadName: row.workloadName,
	namespace: row.namespace,
	clusterName: row.clusterName,
	podCount: row.podCount || 0,
	avgCpuLimitUtilization: row.avgCpuLimitUtilization == null ? null : row.avgCpuLimitUtilization,
	avgMemoryLimitUtilization: row.avgMemoryLimitUtilization == null ? null : row.avgMemoryLimitUtilization,
})

/** `toServicePlatformRow`: host infrastructure first, then SDK self-report. */
const platformOf = (row: CH.ServicePlatformsOutput) =>
	row.cloudPlatform === "cloudflare.workers" || row.cloudProvider === "cloudflare"
		? ("cloudflare" as const)
		: row.cloudProvider === "gcp"
			? ("gcp" as const)
			: row.faasName !== "" || row.cloudPlatform === "aws_lambda"
				? ("lambda" as const)
				: row.k8sPodName !== "" || row.k8sDeploymentName !== ""
					? ("kubernetes" as const)
					: row.mapleSdkType === "client"
						? ("web" as const)
						: ("unknown" as const)

const toServicePlatformRow = (row: CH.ServicePlatformsOutput) => ({
	serviceName: decodeServiceName(row.serviceName),
	platform: platformOf(row),
	k8sCluster: row.k8sCluster,
	cloudPlatform: row.cloudPlatform,
	cloudProvider: row.cloudProvider,
	faasName: row.faasName,
	mapleSdkType: row.mapleSdkType,
	processRuntimeName: row.processRuntimeName,
})

export const serviceEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.serviceOverview": warehouseEndpoint(warehouse, ServiceOverviewRequest, ServiceOverviewResponse, (payload, { runQuery }) =>
		Effect.map(runQuery(Queries.serviceOverview, payload), (rows) => new ServiceOverviewResponse({ data: rows })),
	),
	"queryEngine.serviceHealthSnapshot": warehouseEndpoint(
		warehouse,
		ServiceHealthSnapshotRequest,
		ServiceHealthSnapshotResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.serviceHealthSnapshot, payload),
				(rows) =>
					new ServiceHealthSnapshotResponse({
						data: rows.map((row) => ({
							serviceName: decodeServiceName(row.serviceName),
							environment: row.environment || "unknown",
							requestCount: row.requestCount,
							errorCount: row.errorCount,
							p95LatencyMs: row.p95LatencyMs,
						})),
					}),
			),
	),
	"queryEngine.serviceHealthBaseline": warehouseEndpoint(
		warehouse,
		ServiceHealthBaselineRequest,
		ServiceHealthBaselineResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.serviceHealthBaseline, payload),
				(rows) =>
					new ServiceHealthBaselineResponse({
						data: rows.map((row) => ({
							serviceName: decodeServiceName(row.serviceName),
							serviceNamespace: row.serviceNamespace,
							environment: row.environment,
							baselineP95LatencyMs: row.baselineP95LatencyMs,
							baselineSpanCount: row.baselineSpanCount,
						})),
					}),
			),
	),
	"queryEngine.serviceApdex": warehouseEndpoint(warehouse, ServiceApdexRequest, ServiceApdexResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.serviceApdex, payload),
			(rows) =>
				new ServiceApdexResponse({
					data: rows.map((row) => ({
						bucket: DateTime.formatIso(row.bucket),
						totalCount: row.totalCount,
						satisfiedCount: row.satisfiedCount,
						toleratingCount: row.toleratingCount,
						apdexScore: row.apdexScore,
					})),
				}),
		),
	),
	"queryEngine.serviceUsage": warehouseEndpoint(warehouse, ServiceUsageRequest, ServiceUsageResponse, (payload, { runQuery }) =>
		Effect.map(runQuery(Queries.serviceUsage, payload), (rows) => new ServiceUsageResponse({ data: rows })),
	),
	"queryEngine.serviceDetailOverview": warehouseEndpoint(
		warehouse,
		ServiceDetailOverviewRequest,
		ServiceDetailOverviewResponse,
		(payload, { runQuery, tenant }) =>
			Effect.gen(function* () {
				const [timeseries, releaseRows, environmentRows] = yield* Effect.all([
					warehouse.executeQuery(tenant, payload.timeseries),
					runQuery(Queries.serviceReleases, payload),
					runQuery(Queries.serviceEnvironments, {
						serviceName: payload.serviceName,
						startTime: payload.startTime,
						endTime: payload.endTime,
					}),
				])
				return new ServiceDetailOverviewResponse({
					timeseries,
					releases: releaseRows.map((row) => ({
						bucket: DateTime.formatIso(row.bucket),
						commitSha: decodeCommitSha(row.commitSha),
						count: row.count,
						errorCount: row.errorCount,
					})),
					environments: environmentRows.map((row) => row.environment).filter((env) => env !== ""),
				})
			}),
	),
	"queryEngine.serviceWorkloads": warehouseEndpoint(
		warehouse,
		ServiceWorkloadsRequest,
		ServiceWorkloadsResponse,
		(payload, { runQuery }) =>
			payload.services.length === 0
				? Effect.succeed(new ServiceWorkloadsResponse({ data: [] }))
				: Effect.map(
						runQuery(Queries.serviceWorkloads, payload),
						(rows) => new ServiceWorkloadsResponse({ data: rows.map(toServiceWorkloadRow) }),
					),
	),
	"queryEngine.serviceDependenciesBundle": warehouseEndpoint(
		warehouse,
		ServiceDependenciesBundleRequest,
		ServiceDependenciesBundleResponse,
		(payload, { runQuery }) =>
			Effect.map(
				Effect.all([
					runQuery(Queries.serviceDependenciesForService, payload),
					runQuery(Queries.serviceDbEdgesForService, payload),
					runQuery(Queries.serviceExternalEdges, payload),
				]),
				([dependencyRows, dbEdgeRows, externalEdgeRows]) =>
					new ServiceDependenciesBundleResponse({
						dependencies: dependencyRows.map((row) => ({ ...row })),
						dbEdges: dbEdgeRows.map((row) => ({ ...row })),
						externalEdges: externalEdgeRows.map((row) => ({ ...row })),
					}),
			),
	),
	"queryEngine.serviceMapBundle": warehouseEndpoint(warehouse, ServiceMapBundleRequest, ServiceMapBundleResponse, (payload, { runQuery }) =>
		Effect.gen(function* () {
			const [dependencyRows, overviewRows, dbEdgeRows, platformRows] = yield* Effect.all([
				runQuery(Queries.serviceDependencies, payload),
				runQuery(Queries.serviceOverview, payload),
				runQuery(Queries.serviceDbEdges, payload),
				runQuery(Queries.servicePlatforms, payload),
			])
			const services = new Set([
				...dependencyRows.flatMap((row) => [row.sourceService, row.targetService]),
				...overviewRows.map((row) => row.serviceName),
			])
			services.delete("")
			const workloadRows =
				services.size === 0
					? []
					: yield* runQuery(Queries.serviceWorkloads, {
							startTime: payload.startTime,
							endTime: payload.endTime,
							services: Array.from(services)
								.sort()
								.map((name) => decodeServiceName(name)),
						})
			return new ServiceMapBundleResponse({
				dependencies: dependencyRows.map((row) => ({ ...row })),
				dbEdges: dbEdgeRows.map((row) => ({ ...row })),
				overview: overviewRows.map((row) => ({ ...row })),
				platforms: platformRows.map(toServicePlatformRow),
				workloads: workloadRows.map(toServiceWorkloadRow),
			})
		}),
	),
})
