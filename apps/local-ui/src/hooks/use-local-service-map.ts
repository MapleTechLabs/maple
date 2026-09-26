import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH, coerceServiceOverviewRows, summarizeSampling, type ServiceOverview } from "@maple/query-engine"
import type {
	ServiceMapDbEdgeRow,
	ServiceMapEdgeRow,
	ServicePlatform,
} from "@maple/ui/components/service-map/service-map-types"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import type { TimeBounds } from "../lib/time"

export interface LocalServiceMapData {
	readonly edges: ReadonlyArray<ServiceMapEdgeRow>
	readonly dbEdges: ReadonlyArray<ServiceMapDbEdgeRow>
	/** One row per (service, environment), sampling-corrected like the cloud map's. */
	readonly overviews: ReadonlyArray<ServiceOverview>
	readonly platforms: ReadonlyMap<string, ServicePlatform>
	/** `process.runtime.name` per service. */
	readonly runtimes: ReadonlyMap<string, string>
}

interface EdgeTotals {
	callCount: number
	errorCount: number
	durationSumMs: number
	maxDurationMs: number
	estimatedSpanCount: number
}

/**
 * Service-to-service edges over the whole window from the raw span join.
 *
 * The cloud map's `serviceDependenciesSQL` reads whole hours from
 * `service_map_edges_hourly`, which only the cloud's scheduled rollup fills;
 * nothing writes it locally, so this runs that rollup's join over the window.
 */
type EdgeBucket = Pick<
	CH.ServiceMapEdgesHourlyOutput,
	| "SourceService"
	| "TargetService"
	| "CallCount"
	| "ErrorCount"
	| "DurationSumMs"
	| "MaxDurationMs"
	| "SampleRateSum"
>

export function aggregateEdges(
	rows: ReadonlyArray<EdgeBucket>,
	durationSeconds: number,
): ServiceMapEdgeRow[] {
	const totals = new Map<string, { source: string; target: string; t: EdgeTotals }>()
	for (const row of rows) {
		const key = `${row.SourceService}\u0000${row.TargetService}`
		const entry = totals.get(key) ?? {
			source: row.SourceService,
			target: row.TargetService,
			t: { callCount: 0, errorCount: 0, durationSumMs: 0, maxDurationMs: 0, estimatedSpanCount: 0 },
		}
		const callCount = Number(row.CallCount)
		const sampleRateSum = Number(row.SampleRateSum)
		entry.t.callCount += callCount
		entry.t.errorCount += Number(row.ErrorCount)
		entry.t.durationSumMs += Number(row.DurationSumMs)
		entry.t.maxDurationMs = Math.max(entry.t.maxDurationMs, Number(row.MaxDurationMs))
		entry.t.estimatedSpanCount += sampleRateSum > 0 ? sampleRateSum : callCount
		totals.set(key, entry)
	}
	return Array.from(totals.values(), ({ source, target, t }) => {
		const sampling = summarizeSampling(t.estimatedSpanCount, t.callCount, durationSeconds)
		return {
			sourceService: source,
			targetService: target,
			callCount: t.callCount,
			estimatedCallCount: sampling.hasSampling ? Math.round(t.estimatedSpanCount) : t.callCount,
			errorCount: t.errorCount,
			errorRate: t.callCount > 0 ? t.errorCount / t.callCount : 0,
			avgDurationMs: t.callCount > 0 ? t.durationSumMs / t.callCount : 0,
			maxDurationMs: t.maxDurationMs,
			hasSampling: sampling.hasSampling,
			samplingWeight: sampling.weight,
		}
	}).sort((a, b) => b.callCount - a.callCount)
}

function toDbEdge(row: CH.ServiceDbEdgesOutput, durationSeconds: number): ServiceMapDbEdgeRow {
	const callCount = Number(row.callCount)
	const errorCount = Number(row.errorCount)
	const estimatedSpanCount = Number(row.estimatedSpanCount)
	const sampling = summarizeSampling(estimatedSpanCount, callCount, durationSeconds)
	return {
		sourceService: row.sourceService,
		dbSystem: row.dbSystem,
		dbNamespace: row.dbNamespace,
		callCount,
		estimatedCallCount: sampling.hasSampling ? Math.round(estimatedSpanCount) : callCount,
		errorCount,
		errorRate: callCount > 0 ? errorCount / callCount : 0,
		avgDurationMs: Number(row.avgDurationMs),
		maxDurationMs: Number(row.maxDurationMs),
		p95DurationMs: Number(row.p95DurationMs),
		hasSampling: sampling.hasSampling,
		samplingWeight: sampling.weight,
	}
}

/** Same precedence as the cloud API's platform classifier: host infrastructure beats SDK self-report. */
export function classifyPlatform(row: CH.ServicePlatformsOutput): ServicePlatform {
	if (row.cloudPlatform === "cloudflare.workers" || row.cloudProvider === "cloudflare") return "cloudflare"
	if (row.faasName !== "" || row.cloudPlatform === "aws_lambda") return "lambda"
	// `k8s.cluster.name` alone does not prove the service runs in Kubernetes.
	if (row.k8sPodName !== "" || row.k8sDeploymentName !== "") return "kubernetes"
	return row.mapleSdkType === "client" ? "web" : "unknown"
}

/**
 * Everything the service map draws, from the same query-engine builders the
 * cloud map's bundle uses: edges, database edges, per-service overview stats,
 * and platform/runtime badges.
 */
export function useLocalServiceMap(bounds: TimeBounds, durationSeconds: number) {
	return useQuery({
		queryKey: ["local", "service-map", boundsKey(bounds), durationSeconds],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<LocalServiceMapData> => {
			const params = localParams(bounds)
			const [edgeRows, dbEdgeRows, overviewRows, platformRows] = await Promise.all([
				executeLocalCompiledQuery(
					CH.serviceMapEdgesRollupSQL({
						orgId: LOCAL_ORG_ID,
						hourStart: bounds.startTime,
						hourEnd: bounds.endTime,
					}),
					signal,
				),
				executeLocalCompiledQuery(CH.serviceDbEdgesSQL({}, params), signal),
				executeLocalCompiledQuery(CH.compile(CH.serviceOverviewQuery({}), params), signal),
				executeLocalCompiledQuery(CH.servicePlatformsSQL({}, params), signal),
			])

			const platforms = new Map<string, ServicePlatform>()
			const runtimes = new Map<string, string>()
			for (const row of platformRows) {
				platforms.set(row.serviceName, classifyPlatform(row))
				if (row.processRuntimeName) runtimes.set(row.serviceName, row.processRuntimeName)
			}

			return {
				edges: aggregateEdges(edgeRows, durationSeconds),
				dbEdges: dbEdgeRows.map((row) => toDbEdge(row, durationSeconds)),
				overviews: coerceServiceOverviewRows(overviewRows, durationSeconds),
				platforms,
				runtimes,
			}
		},
	})
}
