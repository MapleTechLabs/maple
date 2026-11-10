import type { VercelDeploymentSummary, VercelInfraRequestBucket } from "@maple/domain/http"
import { toEpochMs } from "@maple/ui/lib/time-format"
import type { ChartEventMarker } from "@maple/views/charts/event-marker-spec"
import { Array as Arr, Order, String as Str } from "effect"

// Deploys on the request charts: which production deploys landed in the window, and which of them
// were followed by a jump in 5xx responses.

/** When a deployment started serving: ready, or created for one that never got there. */
export const deployedAt = (deployment: VercelDeploymentSummary): number =>
	deployment.readyAt ?? deployment.createdAt

const isProduction = (deployment: VercelDeploymentSummary) => deployment.target === "production"

/** The production deployments created inside the window, oldest first. */
export const productionDeploysIn = (
	deployments: ReadonlyArray<VercelDeploymentSummary>,
	window: Readonly<{ startMs: number; endMs: number }>,
): ReadonlyArray<VercelDeploymentSummary> =>
	Arr.sort(
		Arr.filter(deployments, (d) => {
			const at = deployedAt(d)
			return isProduction(d) && at >= window.startMs && at <= window.endMs
		}),
		Order.mapInput(Order.Number, deployedAt),
	)

/** A production deploy followed by a jump in the 5xx rate. */
export type DeployRegression = Readonly<{
	deployment: VercelDeploymentSummary
	/** 5xx share of requests in the buckets before the deploy. */
	beforeRate: number
	/** The worst bucket after it. */
	peakRate: number
	peakAt: string
	/** When the rate settled again, the next deploy landed, or the window's last bucket ended. */
	endsAtMs: number
	/** The deploy whose arrival ended the regression, when one did. */
	resolvedBy: VercelDeploymentSummary | null
	/** 5xx responses between the deploy and `endsAtMs`. */
	failedRequests: number
}>

/** How many buckets either side of a deploy are read. */
const LOOK_BUCKETS = 6
/** A bucket with fewer requests says little about a rate. */
const MIN_BUCKET_REQUESTS = 20
/** A regression peaks at 1% or more, and at least three times the rate before plus half a point. */
const MIN_PEAK_RATE = 0.01

const rateOf = (b: VercelInfraRequestBucket) => (b.requests > 0 ? b.requests5xx / b.requests : 0)

/**
 * Each production deploy in `deploys` whose following buckets' 5xx rate jumped well above the
 * rate before it. `buckets` must be sorted and evenly spaced by `bucketMs`.
 */
export function deployRegressions(
	buckets: ReadonlyArray<VercelInfraRequestBucket>,
	deploys: ReadonlyArray<VercelDeploymentSummary>,
	bucketMs: number,
): ReadonlyArray<DeployRegression> {
	const timed = Arr.map(buckets, (b) => ({ b, ms: toEpochMs(b.bucket) }))
	const sorted = Arr.sort(deploys, Order.mapInput(Order.Number, deployedAt))
	return Arr.flatMap(sorted, (deployment, index) => {
		const at = deployedAt(deployment)
		const next = sorted[index + 1]
		const nextAt = next === undefined ? Number.POSITIVE_INFINITY : deployedAt(next)
		const before = Arr.filter(timed, ({ ms }) => ms + bucketMs <= at).slice(-LOOK_BUCKETS)
		const beforeRequests = Arr.reduce(before, 0, (n, { b }) => n + b.requests)
		const beforeRate =
			beforeRequests > 0 ? Arr.reduce(before, 0, (n, { b }) => n + b.requests5xx) / beforeRequests : 0
		// The deploy's own bucket counts: a bad deploy fails requests from its first minute.
		const after = Arr.filter(timed, ({ ms }) => ms + bucketMs > at && ms < nextAt).slice(0, LOOK_BUCKETS)
		const read = Arr.filter(after, ({ b }) => b.requests >= MIN_BUCKET_REQUESTS)
		const peak = Arr.reduce(read, null as (typeof read)[number] | null, (best, cur) =>
			best === null || rateOf(cur.b) > rateOf(best.b) ? cur : best,
		)
		if (peak === null) return []
		const peakRate = rateOf(peak.b)
		if (peakRate < MIN_PEAK_RATE || peakRate < beforeRate * 3 + 0.005) return []
		const settled = Arr.findFirst(
			timed,
			({ b, ms }) => ms > peak.ms && ms < nextAt && rateOf(b) <= beforeRate * 1.5 + 0.002,
		)
		const lastBucket = timed[timed.length - 1]
		const endsAtMs =
			settled._tag === "Some"
				? settled.value.ms
				: Number.isFinite(nextAt)
					? nextAt
					: lastBucket === undefined
						? at
						: lastBucket.ms + bucketMs
		const resolvedBy = next !== undefined && endsAtMs >= nextAt - bucketMs ? next : null
		const failedRequests = Arr.reduce(
			Arr.filter(timed, ({ ms }) => ms + bucketMs > at && ms < endsAtMs),
			0,
			(n, { b }) => n + b.requests5xx,
		)
		return [{ deployment, beforeRate, peakRate, peakAt: peak.b.bucket, endsAtMs, resolvedBy, failedRequests }]
	})
}

/** The commit's short sha, or the deployment id when Vercel has no commit. */
export const deployLabel = (deployment: VercelDeploymentSummary): string =>
	deployment.commitSha === null ? deployment.id : Str.slice(0, 7)(deployment.commitSha)

/**
 * The chart markers for production deploys: a regression is critical and spans its window, a
 * failed build is a warning, the rest are neutral.
 */
export function deployMarkers(
	deploys: ReadonlyArray<VercelDeploymentSummary>,
	regressions: ReadonlyArray<DeployRegression>,
	labelOf: (deployment: VercelDeploymentSummary) => string = deployLabel,
): ReadonlyArray<ChartEventMarker> {
	const regressed = new Map(Arr.map(regressions, (r) => [r.deployment.id, r] as const))
	return Arr.map(deploys, (deployment) => {
		const regression = regressed.get(deployment.id)
		const at = new Date(deployedAt(deployment)).toISOString()
		if (regression !== undefined)
			return {
				id: deployment.id,
				at,
				label: labelOf(deployment),
				tone: "crit" as const,
				endsAt: new Date(regression.endsAtMs).toISOString(),
			}
		return {
			id: deployment.id,
			at,
			label: labelOf(deployment),
			tone: deployment.state === "ERROR" ? ("warn" as const) : ("neutral" as const),
		}
	})
}
