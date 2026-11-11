import type {
	VercelInfraLatencyBucket,
	VercelInfraRequestBucket,
	VercelIntegrationStatus,
} from "@maple/domain/http"
import { toEpochMs } from "@maple/ui/lib/time-format"
import type { ChartEventMarker } from "@maple/views/charts/event-marker-spec"
import { Array as Arr } from "effect"
import type { DeployRegression } from "../deploy-signals"
import { fillBuckets, type VercelProjectRow, vercelProjectRows, zeroRequestBucket } from "../list-model"
import { teamDeploySignals, type Window } from "../overview-model"
import { seriesInput } from "../data"
import { dataOf } from "../view-parts"
import type { Model } from "./model"

// What the overview's parts share: the window in ms, the joined project rows, the filled request
// series and the deploys on it.

export type Overview = Readonly<{
	status: VercelIntegrationStatus
	window: Window
	/** Null while the projects load or after their read failed. */
	rows: ReadonlyArray<VercelProjectRow> | null
	buckets: ReadonlyArray<VercelInfraRequestBucket>
	/** Null while it loads, after its read failed, or with the traces drain off. */
	latency: ReadonlyArray<VercelInfraLatencyBucket> | null
	markers: ReadonlyArray<ChartEventMarker>
	regressions: ReadonlyArray<DeployRegression>
	projectName: (projectId: string) => string
}>

/** A bucket without invocations has no latency: its gap stays a gap. */
const zeroLatencyBucket = (bucket: string): VercelInfraLatencyBucket => ({
	bucket,
	edgeP50Ms: null,
	edgeP95Ms: null,
	invocations: 0,
	coldStarts: 0,
	invokeP50Ms: null,
	invokeP95Ms: null,
})

export const overviewOf = (model: Model, status: VercelIntegrationStatus): Overview => {
	const names = new Map(Arr.map(status.projects, (project) => [project.id, project.name] as const))
	const projectName = (projectId: string) => names.get(projectId) ?? projectId
	const projects = dataOf(model.projects.data)
	const series = model.window === null ? null : seriesInput(model.window)
	const window =
		series === null
			? { startMs: model.nowMs, endMs: model.nowMs }
			: { startMs: toEpochMs(series.startTime), endMs: toEpochMs(series.endTime) }
	const buckets =
		series === null ? [] : fillBuckets(dataOf(model.buckets.data) ?? [], series, zeroRequestBucket)
	const latency = dataOf(model.latency.data)
	const signals = teamDeploySignals({
		deployments: dataOf(model.deployments.data) ?? [],
		buckets,
		window,
		bucketMs: (series?.bucketSeconds ?? 0) * 1000,
		projectName,
	})
	return {
		status,
		window,
		rows: projects === null ? null : vercelProjectRows(status.projects, projects),
		buckets,
		latency:
			latency === null || series === null || !status.tracesEnabled
				? null
				: fillBuckets(latency, series, zeroLatencyBucket),
		markers: signals.markers,
		regressions: signals.regressions,
		projectName,
	}
}
