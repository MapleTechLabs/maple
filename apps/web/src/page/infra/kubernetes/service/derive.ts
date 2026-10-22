import { chartBucketSeconds } from "../../../../components/infra/chart-units"
import { toIsoBucket } from "@maple/web-data/warehouse/timeseries-utils"
import { AsyncData } from "foldkit"
import type { TimeWindow } from "../../../../data/time-range"
import type { ServiceWorkload } from "../lens/rail"
import type { Model } from "./model"

// Pure derivations of `LensBody`.

export type LinkedWorkload = Readonly<{
	workloadKind: "deployment" | "statefulset" | "daemonset"
	workloadName: string
	namespace: string
	clusterName: string
	podCount: number
}>

/** `firstLinkedWorkload`: the first row with a kind the downstream queries accept. */
export const linkedWorkload = (model: Model): LinkedWorkload | null => {
	const rows: ReadonlyArray<ServiceWorkload> = AsyncData.getOrElse(model.linked.data, () => [])
	const found = rows.find((row) => row.workloadKind !== "unknown")
	if (found === undefined || found.workloadKind === "unknown") return null
	return {
		workloadKind: found.workloadKind,
		workloadName: found.workloadName,
		namespace: found.namespace,
		clusterName: found.clusterName,
		podCount: found.podCount,
	}
}

const bucketMs = (bucket: string): number => new Date(toIsoBucket(bucket)).getTime()

/** The bucket width the service series came back on, so the pod gauges match its grid. */
export const bucketSecondsOf = (model: Model, window: TimeWindow): number => {
	const points = AsyncData.getOrElse(model.overview.data, () => [])
	const first = points[0]?.bucket
	const second = points[1]?.bucket
	if (first && second) {
		const delta = Math.round((bucketMs(second) - bucketMs(first)) / 1000)
		if (Number.isFinite(delta) && delta > 0) return delta
	}
	return chartBucketSeconds(window.startTime, window.endTime)
}

/** `worstPerBucket`: the worst pod per bucket, sorted by bucket. */
export const worstPerBucket = (
	rows: ReadonlyArray<Readonly<{ bucket: string; value: number }>>,
): ReadonlyArray<Readonly<{ bucket: string; value: number }>> =>
	[
		...rows
			.reduce((byBucket, row) => {
				const current = byBucket.get(row.bucket)
				return current === undefined || row.value > current
					? byBucket.set(row.bucket, row.value)
					: byBucket
			}, new Map<string, number>())
			.entries(),
	]
		.map(([bucket, value]) => ({ bucket, value }))
		.sort((a, b) => a.bucket.localeCompare(b.bucket))

/** The CPU rows on the service series' bucket spelling (`toIsoBucket`). */
export const cpuRowsOf = (model: Model) =>
	AsyncData.getOrElse(model.cpu.data, () => []).map((row) => ({ ...row, bucket: toIsoBucket(row.bucket) }))
