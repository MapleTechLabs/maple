import type { ListHostsResponse } from "@maple/domain/http"
import { RailwayEnvironmentStatus } from "@maple/domain/http"
import type { CloudflareZoneRow } from "@maple/web-data/warehouse/cloudflare-infra"
import type { RailwayServiceRow } from "@maple/web-data/warehouse/railway-infra"
import type { PlanetScaleDatabaseStat } from "@maple/web-data/warehouse/service-map"
import {
	type SourceId,
	type SourceSummary,
	summarizeCloudflare,
	summarizeContainers,
	summarizeHosts,
	summarizePlanetScale,
	summarizePods,
	summarizeRailway,
} from "../components/infra/overview/summaries"

/**
 * `/lab/infra`'s rows: a host fleet, Railway services in two environments, Cloudflare zones and
 * PlanetScale databases, all relative to `nowMs`.
 */
type HostRow = ListHostsResponse["data"][number]

export interface InfraLabFixture {
	readonly end: string
	readonly hosts: ReadonlyArray<HostRow>
	readonly railway: ReadonlyArray<RailwayServiceRow>
	readonly railwayEnvironments: ReadonlyArray<RailwayEnvironmentStatus>
	readonly summaries: ReadonlyArray<readonly [SourceId, SourceSummary]>
}

function railwayRows(ago: (ms: number) => string): ReadonlyArray<RailwayServiceRow> {
	const railway = (
		serviceName: string,
		cpuMax: number,
		cpuLimit: number,
		memoryMaxGb: number,
		memoryLimitGb: number,
		replicas: number,
	): RailwayServiceRow => ({
		environmentId: "env-prod",
		serviceId: `svc-${serviceName}`,
		serviceName,
		projectName: "storefront",
		environmentName: "production",
		cpuAvg: cpuMax * 0.7,
		cpuMax,
		cpuLimit,
		memoryAvg: memoryMaxGb * 0.8 * 1e9,
		memoryMax: memoryMaxGb * 1e9,
		memoryLimit: memoryLimitGb * 1e9,
		replicas,
		lastSeen: ago(60_000),
	})
	return [
		railway("api", 1.86, 2, 2.4, 4, 3),
		railway("worker", 1.52, 4, 4.2, 8, 2),
		railway("web", 0.21, 1, 0.33, 1, 4),
		railway("postgres", 0.24, 2, 1.8, 4, 1),
		railway("nightly-export", 0.04, 0, 0.1, 0, 1),
		{
			...railway("preview-api", 0.12, 2, 0.6, 4, 1),
			environmentId: "env-staging",
			environmentName: "staging",
		},
	]
}

const railwayEnvironment = (
	nowMs: number,
	environmentId: string,
	environmentName: string,
	lastError: string | null,
) =>
	new RailwayEnvironmentStatus({
		projectId: "proj-storefront",
		projectName: "storefront",
		environmentId,
		environmentName,
		serviceCount: 1,
		enabled: true,
		lastSyncedAt: nowMs - 2 * 60_000,
		lastError,
	})

function cloudflareZones(): ReadonlyArray<CloudflareZoneRow> {
	const zone = (
		zoneName: string,
		requests: number,
		errorRate: number,
		originP99Ms: number,
	): CloudflareZoneRow => ({
		serviceName: `cloudflare/${zoneName}`,
		zoneName,
		requests,
		errors4xx: 0,
		clientErrorRate: 0,
		requests2xx: requests,
		requests3xx: 0,
		cacheableRequests: requests,
		errors5xx: Math.round(requests * errorRate),
		errorRate,
		cacheHits: requests * 0.91,
		cacheHitRate: 0.91,
		bytes: 0,
		visits: 0,
		ttfbP50Ms: 0,
		ttfbP95Ms: 0,
		ttfbP99Ms: 0,
		originP50Ms: 0,
		originP95Ms: 0,
		originP99Ms,
	})
	return [
		zone("api.acme.dev", 21_400_000, 0.042, 2400),
		zone("acme.dev", 18_900_000, 0.001, 310),
		zone("docs.acme.dev", 7_900_000, 0, 120),
	]
}

function planetScaleDatabases(): ReadonlyArray<PlanetScaleDatabaseStat> {
	const db = (
		database: string,
		replicaLagMaxSeconds: number,
		storageUsedPercent: number,
	): PlanetScaleDatabaseStat => ({
		database,
		connectionsAvg: 40,
		connectionsMax: 80,
		cpuMaxPercent: 30,
		memMaxPercent: 40,
		replicaLagMaxSeconds,
		storageUsedPercent,
	})
	return [db("ledger", 41, 81), db("users", 0.2, 34), db("events", 0.4, 52)]
}

export function buildInfraLabFixture(nowMs: number): InfraLabFixture {
	const ago = (ms: number) => new Date(nowMs - ms).toISOString()
	const end = ago(0)
	const host = (
		hostName: string,
		cpuPct: number,
		memoryPct: number,
		diskPct: number,
		seenMs = 4_000,
	): HostRow => ({
		hostName,
		osType: "linux",
		hostArch: hostName.startsWith("db") ? "arm64" : "amd64",
		cloudProvider: "aws",
		lastSeen: ago(seenMs),
		cpuPct,
		memoryPct,
		diskPct,
		load15: cpuPct * 8,
	})
	const hosts: ReadonlyArray<HostRow> = [
		host("worker-eu-07", 0.94, 0.62, 0.41),
		host("api-eu-02", 0.81, 0.74, 0.33),
		host("ingest-eu-01", 0.66, 0.58, 0.29),
		host("db-proxy-eu-01", 0.47, 0.58, 0.19),
		{ ...host("edge-eu-03", 0.22, 0.31, 0.12), cloudProvider: "gcp" },
		{ ...host("win-agent-01", 0.19, 0.28, 0.12), osType: "windows", cloudProvider: "azure" },
		host("scheduler-eu-01", 0.11, 0.24, 0.31),
		{
			...host("build-runner-03", 0.05, 0.12, 0.44, 2 * 60 * 60 * 1000),
			osType: "darwin",
			hostArch: "arm64",
		},
	]
	const railway = railwayRows(ago)
	const zones = cloudflareZones()
	const databases = planetScaleDatabases()
	return {
		end,
		hosts,
		railway,
		railwayEnvironments: [
			railwayEnvironment(nowMs, "env-prod", "production", null),
			railwayEnvironment(nowMs, "env-staging", "staging", "Railway answered 429 Too Many Requests"),
		],
		summaries: [
			["hosts", summarizeHosts(hosts, end)],
			[
				"containers",
				summarizeContainers({
					totalContainers: 41,
					saturatedContainers: 1,
					elevatedContainers: 4,
					staleContainers: 0,
				}),
			],
			[
				"kubernetes",
				summarizePods({
					livePods: 562,
					endedPods: 12,
					saturatedPods: 9,
					elevatedPods: 18,
					unboundedPods: 0,
				}),
			],
			["cloudflare", summarizeCloudflare(zones)],
			["railway", summarizeRailway(railway)],
			["planetscale", summarizePlanetScale(databases)],
		],
	}
}
