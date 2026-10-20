import type { PodRestartsResponse } from "@maple/domain/http"
import type { Tone } from "@maple/ui/lib/tone"

export type PodRestartRow = PodRestartsResponse["data"][number]

export interface PodRestartSummary {
	/** Restarts inside the window, summed over the pod's containers. */
	readonly restarts: number
	/** Running totals summed over the pod's containers. */
	readonly totalRestarts: number
	/** The reason from the container that restarted most, or any container that has one. */
	readonly lastTerminatedReason: string
}

/** Row identity. A pod name repeats across namespaces; the pair doesn't. */
export const podKey = (pod: { namespace: string; podName: string }) => `${pod.namespace}/${pod.podName}`

const byMostRestarts = (a: PodRestartRow, b: PodRestartRow) =>
	b.restarts - a.restarts || b.totalRestarts - a.totalRestarts

/** Folds per-container rows into one summary per pod, keyed by `podKey`. */
export function summarizePodRestarts(
	rows: ReadonlyArray<PodRestartRow>,
): ReadonlyMap<string, PodRestartSummary> {
	const byPod = new Map<string, Array<PodRestartRow>>()
	for (const row of rows) {
		const key = podKey(row)
		const containers = byPod.get(key)
		if (containers) containers.push(row)
		else byPod.set(key, [row])
	}
	return new Map(
		[...byPod].map(([key, containers]) => {
			const ranked = [...containers].sort(byMostRestarts)
			return [
				key,
				{
					restarts: ranked.reduce((sum, c) => sum + c.restarts, 0),
					totalRestarts: ranked.reduce((sum, c) => sum + c.totalRestarts, 0),
					lastTerminatedReason:
						ranked.find((c) => c.lastTerminatedReason !== "")?.lastTerminatedReason ?? "",
				},
			]
		}),
	)
}

/** An OOM kill is the one reason that says "raise the limit", so it reads as critical. */
export function restartTone(restarts: number, reason: string): Tone {
	if (restarts <= 0) return "neutral"
	return reason === "OOMKilled" ? "crit" : "warn"
}

export const formatRestarts = (n: number) => `${n} ${n === 1 ? "restart" : "restarts"}`
