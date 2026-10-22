import { CH, summarizeSampling } from "@maple/query-engine"
import type {
	ServiceMapDbEdgeRow,
	ServiceMapEdgeRow,
	ServicePlatform,
} from "@maple/ui/components/service-map/service-map-types"

// `aggregateEdges`, `toDbEdge`, `classifyPlatform`: the map's raw rows folded into edges and
// database nodes.

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

interface EdgeTotals {
	readonly source: string
	readonly target: string
	readonly callCount: number
	readonly errorCount: number
	readonly durationSumMs: number
	readonly maxDurationMs: number
	readonly estimatedSpanCount: number
}

const addBucket = (
	totals: ReadonlyMap<string, EdgeTotals>,
	row: EdgeBucket,
): ReadonlyMap<string, EdgeTotals> => {
	const key = `${row.SourceService}\u0000${row.TargetService}`
	const entry = totals.get(key) ?? {
		source: row.SourceService,
		target: row.TargetService,
		callCount: 0,
		errorCount: 0,
		durationSumMs: 0,
		maxDurationMs: 0,
		estimatedSpanCount: 0,
	}
	return new Map(totals).set(key, {
		...entry,
		callCount: entry.callCount + row.CallCount,
		errorCount: entry.errorCount + row.ErrorCount,
		durationSumMs: entry.durationSumMs + row.DurationSumMs,
		maxDurationMs: Math.max(entry.maxDurationMs, row.MaxDurationMs),
		estimatedSpanCount:
			entry.estimatedSpanCount + (row.SampleRateSum > 0 ? row.SampleRateSum : row.CallCount),
	})
}

/** Service-to-service edges over the whole window, summed from the raw span join's buckets. */
export const aggregateEdges = (
	rows: ReadonlyArray<EdgeBucket>,
	durationSeconds: number,
): Array<ServiceMapEdgeRow> =>
	Array.from(rows.reduce(addBucket, new Map<string, EdgeTotals>()).values(), (t) => {
		const sampling = summarizeSampling(t.estimatedSpanCount, t.callCount, durationSeconds)
		return {
			sourceService: t.source,
			targetService: t.target,
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

export const toDbEdge = (row: CH.ServiceDbEdgesOutput, durationSeconds: number): ServiceMapDbEdgeRow => {
	const { callCount, errorCount, estimatedSpanCount } = row
	const sampling = summarizeSampling(estimatedSpanCount, callCount, durationSeconds)
	return {
		sourceService: row.sourceService,
		dbSystem: row.dbSystem,
		dbNamespace: row.dbNamespace,
		callCount,
		estimatedCallCount: sampling.hasSampling ? Math.round(estimatedSpanCount) : callCount,
		errorCount,
		errorRate: callCount > 0 ? errorCount / callCount : 0,
		avgDurationMs: row.avgDurationMs,
		maxDurationMs: row.maxDurationMs,
		p95DurationMs: row.p95DurationMs,
		hasSampling: sampling.hasSampling,
		samplingWeight: sampling.weight,
	}
}

/** Same precedence as the cloud API's platform classifier: host infrastructure beats SDK self-report. */
export const classifyPlatform = (row: CH.ServicePlatformsOutput): ServicePlatform => {
	if (row.cloudPlatform === "cloudflare.workers" || row.cloudProvider === "cloudflare") return "cloudflare"
	// Before the Lambda rule: Google Cloud's detector sets `faas.name` on Cloud Run and Cloud Functions.
	if (row.cloudProvider === "gcp") return "gcp"
	if (row.faasName !== "" || row.cloudPlatform === "aws_lambda") return "lambda"
	// `k8s.cluster.name` alone does not prove the service runs in Kubernetes.
	if (row.k8sPodName !== "" || row.k8sDeploymentName !== "") return "kubernetes"
	return row.mapleSdkType === "client" ? "web" : "unknown"
}
