import { Atom } from "@/lib/effect-atom"
import { Effect, Schema } from "effect"
import { encodeKey } from "@/lib/cache-key"
import {
	getCustomChartServiceDetail,
	getCustomChartServiceSparklines,
	getCustomChartTimeSeries,
	getOverviewTimeSeries,
} from "@/api/tinybird/custom-charts"
import {
	getErrorDetailTraces,
	getErrorsByType,
	getErrorsFacets,
	getErrorsSummary,
	getErrorsTimeseries,
} from "@/api/tinybird/errors"
import {
	getLog,
	getLogAttributeKeys,
	getLogAttributeValues,
	getLogsFacets,
	listLogs,
} from "@/api/tinybird/logs"
import {
	getMetricAttributeKeys,
	getMetricTimeSeries,
	getMetricsSummary,
	listMetrics,
} from "@/api/tinybird/metrics"
import {
	fleetUtilizationTimeseries,
	getNodeFacets,
	getPodFacets,
	getWorkloadFacets,
	hostDetailSummary,
	hostInfraTimeseries,
	listHosts,
	listPods,
	podDetailSummary,
	podInfraTimeseries,
	listNodes,
	nodeDetailSummary,
	nodeInfraTimeseries,
	listWorkloads,
	workloadDetailSummary,
	workloadInfraTimeseries,
} from "@/api/tinybird/infra"
import { getServiceUsage } from "@/api/tinybird/service-usage"
import {
	getServiceMap,
	getServiceMapDbEdges,
	getServiceMapDbEdgesForService,
	getServiceMapForService,
	getServicePlatforms,
} from "@/api/tinybird/service-map"
import { getServiceExternalEdges } from "@/api/tinybird/service-external-edges"
import { getServiceWorkloads } from "@/api/tinybird/service-infra"
import {
	getServiceApdexTimeSeries,
	getServiceOverview,
	getServiceReleasesTimeline,
	getServicesFacets,
} from "@/api/tinybird/services"
import {
	getResourceAttributeKeys,
	getResourceAttributeValues,
	getSpanAttributeKeys,
	getSpanAttributeValues,
	getSpanDetail,
	getSpanHierarchy,
	getTracesFacets,
	listTraces,
} from "@/api/tinybird/traces"
import { getQueryBuilderTimeseries } from "@/api/tinybird/query-builder-timeseries"
import {
	getReplay,
	getReplayEvents,
	getReplaysForTrace,
	getSessionTraceSummaries,
	listReplays,
} from "@/api/tinybird/replays"
import { normalizeEvents } from "@/components/replays/replay-events"

type QueryEffect<Input, Output> = (input: Input) => Effect.Effect<Output, unknown, unknown>

interface QueryAtomOptions {
	staleTime?: number
}

export class QueryAtomError extends Schema.TaggedErrorClass<QueryAtomError>()(
	"@maple/web/services/QueryAtomError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

const isTaggedBackendError = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	typeof (error as { _tag: unknown })._tag === "string" &&
	(error as { _tag: string })._tag.startsWith("@maple/http/errors/")

const toQueryAtomError = (error: unknown): unknown => {
	if (error instanceof QueryAtomError) return error
	if (isTaggedBackendError(error)) return error
	if (error instanceof Error) {
		return new QueryAtomError({
			message: error.message,
			cause: error,
		})
	}

	return new QueryAtomError({
		message: "Tinybird query atom failed",
		cause: error,
	})
}

function makeQueryAtomFamily<Input, Output>(query: QueryEffect<Input, Output>, options?: QueryAtomOptions) {
	const UnknownFromJson = Schema.fromJsonString(Schema.Unknown)

	const family = Atom.family((key: string) => {
		let resultAtom = Atom.make(
			Schema.decodeUnknownEffect(UnknownFromJson)(key).pipe(
				Effect.flatMap((input) => query(input as Input) as Effect.Effect<Output, unknown, never>),
				Effect.mapError(toQueryAtomError),
			),
		)

		if (options?.staleTime !== undefined) {
			resultAtom = Atom.setIdleTTL(resultAtom, options.staleTime)
		}

		return resultAtom
	})

	return (input: Input) => family(encodeKey(input))
}

export const getServiceUsageResultAtom = makeQueryAtomFamily(getServiceUsage, {
	staleTime: 60_000,
})

export const getServicesFacetsResultAtom = makeQueryAtomFamily(getServicesFacets, {
	// 5 min idle TTL — environments / commit SHAs / service names move slowly,
	// and the dashboard route now reuses this atom for demo-detection (was a
	// separate serviceOverview probe). Cross-route navigation stays warm.
	staleTime: 300_000,
})

export const getServiceOverviewResultAtom = makeQueryAtomFamily(getServiceOverview, {
	staleTime: 30_000,
})

export const getCustomChartServiceSparklinesResultAtom = makeQueryAtomFamily(
	getCustomChartServiceSparklines,
	{
		staleTime: 30_000,
	},
)

export const listTracesResultAtom = makeQueryAtomFamily(listTraces, {
	staleTime: 30_000,
})

export const getTracesFacetsResultAtom = makeQueryAtomFamily(getTracesFacets, {
	staleTime: 30_000,
})

export const getSpanHierarchyResultAtom = makeQueryAtomFamily(getSpanHierarchy)

export const listReplaysResultAtom = makeQueryAtomFamily(listReplays, {
	staleTime: 30_000,
})

export const getReplayResultAtom = makeQueryAtomFamily(getReplay, {
	staleTime: 60_000,
})

export const getSessionTraceSummariesResultAtom = makeQueryAtomFamily(getSessionTraceSummaries, {
	staleTime: 60_000,
})

// No staleTime: signed R2 URLs are short-lived (~5 min), so refetch each mount.
export const getReplayEventsResultAtom = makeQueryAtomFamily(getReplayEvents)

interface ReplayChunkRef {
	readonly chunkSeq: number
	readonly url: string
}

/** Fetch a gzipped rrweb chunk from its signed R2 URL and decode it to events. */
const fetchReplayChunk = (url: string) =>
	Effect.tryPromise({
		try: async (): Promise<ReadonlyArray<unknown>> => {
			const response = await fetch(url)
			if (!response.ok) throw new Error(`chunk fetch failed: ${response.status}`)
			const stream = response.body?.pipeThrough(new DecompressionStream("gzip"))
			const text = stream
				? await new Response(stream).text()
				: // Fallback: already decompressed by the CDN/transport.
					await response.text()
			const parsed: unknown = JSON.parse(text)
			return Array.isArray(parsed) ? parsed : []
		},
		catch: (cause) => new QueryAtomError({ message: "Failed to load session replay chunk", cause }),
	})

/** Build the stable family key for a set of chunk refs (order-independent). */
export const replayChunkEventsKey = (chunks: ReadonlyArray<ReplayChunkRef>): string =>
	JSON.stringify([...chunks].map((c) => ({ chunkSeq: c.chunkSeq, url: c.url })).sort((a, b) => a.chunkSeq - b.chunkSeq))

/**
 * The decoded rrweb event stream for a session, gunzipped from the signed R2
 * chunk URLs produced by `getReplayEventsResultAtom`. No idle TTL: the signed
 * URLs are short-lived (~5 min), so a fresh mount re-signs upstream and the new
 * key re-fetches here.
 */
export const replayChunkEventsAtom = Atom.family((key: string) => {
	const refs = JSON.parse(key) as ReadonlyArray<ReplayChunkRef>
	return Atom.make(
		Effect.gen(function* () {
			const ordered = [...refs].sort((a, b) => a.chunkSeq - b.chunkSeq)
			const decoded = yield* Effect.forEach(ordered, (ref) => fetchReplayChunk(ref.url), {
				concurrency: "unbounded",
			})
			return normalizeEvents(decoded.flat())
		}),
	)
})

export const getReplaysForTraceResultAtom = makeQueryAtomFamily(getReplaysForTrace, {
	staleTime: 60_000,
})

export const getSpanDetailResultAtom = makeQueryAtomFamily(getSpanDetail, {
	staleTime: 60_000,
})

export const listLogsResultAtom = makeQueryAtomFamily(listLogs, {
	staleTime: 30_000,
})

export const getLogResultAtom = makeQueryAtomFamily(getLog, {
	staleTime: 60_000,
})

export const getLogsFacetsResultAtom = makeQueryAtomFamily(getLogsFacets, {
	staleTime: 30_000,
})

export const getErrorsByTypeResultAtom = makeQueryAtomFamily(getErrorsByType, {
	staleTime: 60_000,
})

export const getErrorDetailTracesResultAtom = makeQueryAtomFamily(getErrorDetailTraces, {
	staleTime: 120_000,
})

export const getErrorsFacetsResultAtom = makeQueryAtomFamily(getErrorsFacets, {
	staleTime: 60_000,
})

export const getErrorsSummaryResultAtom = makeQueryAtomFamily(getErrorsSummary, {
	staleTime: 60_000,
})

export const getErrorsTimeseriesResultAtom = makeQueryAtomFamily(getErrorsTimeseries, {
	staleTime: 30_000,
})

export const listMetricsResultAtom = makeQueryAtomFamily(listMetrics, {
	staleTime: 30_000,
})

export const getMetricsSummaryResultAtom = makeQueryAtomFamily(getMetricsSummary, {
	staleTime: 60_000,
})

export const getMetricTimeSeriesResultAtom = makeQueryAtomFamily(getMetricTimeSeries, {
	staleTime: 30_000,
})

export const getMetricAttributeKeysResultAtom = makeQueryAtomFamily(getMetricAttributeKeys, {
	staleTime: 60_000,
})

export const listHostsResultAtom = makeQueryAtomFamily(listHosts, {
	staleTime: 30_000,
})

export const hostDetailSummaryResultAtom = makeQueryAtomFamily(hostDetailSummary, {
	staleTime: 30_000,
})

export const hostInfraTimeseriesResultAtom = makeQueryAtomFamily(hostInfraTimeseries, {
	staleTime: 30_000,
})

export const fleetUtilizationTimeseriesResultAtom = makeQueryAtomFamily(fleetUtilizationTimeseries, {
	staleTime: 30_000,
})

export const listPodsResultAtom = makeQueryAtomFamily(listPods, {
	staleTime: 30_000,
})

export const podDetailSummaryResultAtom = makeQueryAtomFamily(podDetailSummary, {
	staleTime: 30_000,
})

export const podInfraTimeseriesResultAtom = makeQueryAtomFamily(podInfraTimeseries, {
	staleTime: 30_000,
})

export const listNodesResultAtom = makeQueryAtomFamily(listNodes, {
	staleTime: 30_000,
})

export const nodeDetailSummaryResultAtom = makeQueryAtomFamily(nodeDetailSummary, {
	staleTime: 30_000,
})

export const nodeInfraTimeseriesResultAtom = makeQueryAtomFamily(nodeInfraTimeseries, {
	staleTime: 30_000,
})

export const listWorkloadsResultAtom = makeQueryAtomFamily(listWorkloads, {
	staleTime: 30_000,
})

export const workloadDetailSummaryResultAtom = makeQueryAtomFamily(workloadDetailSummary, {
	staleTime: 30_000,
})

export const workloadInfraTimeseriesResultAtom = makeQueryAtomFamily(workloadInfraTimeseries, {
	staleTime: 30_000,
})

export const podFacetsResultAtom = makeQueryAtomFamily(getPodFacets, {
	staleTime: 30_000,
})

export const nodeFacetsResultAtom = makeQueryAtomFamily(getNodeFacets, {
	staleTime: 30_000,
})

export const workloadFacetsResultAtom = makeQueryAtomFamily(getWorkloadFacets, {
	staleTime: 30_000,
})

export const getServiceApdexTimeSeriesResultAtom = makeQueryAtomFamily(getServiceApdexTimeSeries, {
	staleTime: 30_000,
})

export const getServiceReleasesTimelineResultAtom = makeQueryAtomFamily(getServiceReleasesTimeline, {
	staleTime: 60_000,
})

export const getCustomChartServiceDetailResultAtom = makeQueryAtomFamily(getCustomChartServiceDetail, {
	staleTime: 30_000,
})

export const getOverviewTimeSeriesResultAtom = makeQueryAtomFamily(getOverviewTimeSeries, {
	staleTime: 30_000,
})

export const getCustomChartTimeSeriesResultAtom = makeQueryAtomFamily(getCustomChartTimeSeries, {
	staleTime: 30_000,
})

export const getQueryBuilderTimeseriesResultAtom = makeQueryAtomFamily(getQueryBuilderTimeseries, {
	staleTime: 30_000,
})

export const getServiceMapResultAtom = makeQueryAtomFamily(getServiceMap, {
	staleTime: 15_000,
})

export const getServiceMapForServiceResultAtom = makeQueryAtomFamily(getServiceMapForService, {
	staleTime: 15_000,
})

export const getServiceMapDbEdgesResultAtom = makeQueryAtomFamily(getServiceMapDbEdges, {
	staleTime: 15_000,
})

export const getServiceMapDbEdgesForServiceResultAtom = makeQueryAtomFamily(
	getServiceMapDbEdgesForService,
	{ staleTime: 15_000 },
)

export const getServiceExternalEdgesResultAtom = makeQueryAtomFamily(getServiceExternalEdges, {
	staleTime: 30_000,
})

export const getServicePlatformsResultAtom = makeQueryAtomFamily(getServicePlatforms, {
	staleTime: 60_000,
})

export const getServiceWorkloadsResultAtom = makeQueryAtomFamily(getServiceWorkloads, {
	staleTime: 30_000,
})

export const getSpanAttributeKeysResultAtom = makeQueryAtomFamily(getSpanAttributeKeys, {
	staleTime: 60_000,
})

export const getSpanAttributeValuesResultAtom = makeQueryAtomFamily(getSpanAttributeValues, {
	staleTime: 30_000,
})

export const getResourceAttributeKeysResultAtom = makeQueryAtomFamily(getResourceAttributeKeys, {
	staleTime: 60_000,
})

export const getResourceAttributeValuesResultAtom = makeQueryAtomFamily(getResourceAttributeValues, {
	staleTime: 30_000,
})

export const getLogAttributeKeysResultAtom = makeQueryAtomFamily(getLogAttributeKeys, {
	staleTime: 60_000,
})

export const getLogAttributeValuesResultAtom = makeQueryAtomFamily(getLogAttributeValues, {
	staleTime: 30_000,
})
