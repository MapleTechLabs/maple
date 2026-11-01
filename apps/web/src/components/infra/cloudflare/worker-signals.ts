import type {
	CloudflareWorkerDurableObjectBucket,
	CloudflareWorkerLatencyBucket,
	CloudflareWorkerOutcomeBucket,
} from "@maple/web-data/warehouse/cloudflare-infra"
import { shortId } from "@maple/ui/lib/ids"
import type { ChartEventMarker } from "../primitives/chart-event-marker"

type StripRow = { bucket: string; attributeValue: string; value: number }

/** Cloudflare's `worker.status` values, in plain words. Unknown statuses pass through. */
const OUTCOME_LABEL = new Map([
	["success", "Success"],
	["scriptThrewException", "Script threw an exception"],
	["exceededResources", "Exceeded resources"],
	["internalError", "Cloudflare internal error"],
	["clientDisconnected", "Client disconnected"],
	["responseStreamDisconnected", "Response stream disconnected"],
])

export const outcomeLabel = (status: string) => OUTCOME_LABEL.get(status) ?? status

/** Your bug in red, Cloudflare's limits in amber, a client that left in grey. */
const FAILURE_COLOR_BY_STATUS = [
	["scriptThrewException", "var(--severity-error)"],
	["internalError", "var(--severity-fatal)"],
	["exceededResources", "var(--severity-warn)"],
	["clientDisconnected", "var(--muted-foreground)"],
	["responseStreamDisconnected", "var(--muted-foreground)"],
] as const

/** The same colours keyed by the label the strip's series carry. */
export const FAILURE_COLORS: Readonly<Record<string, string>> = Object.fromEntries(
	FAILURE_COLOR_BY_STATUS.map(([status, color]) => [outcomeLabel(status), color]),
)

export const DURABLE_OBJECT_COLORS = {
	calls: "var(--chart-2)",
	errors: "var(--severity-error)",
} satisfies Record<string, string>

export interface WorkerOutcomeTotals {
	invocations: number
	/** Invocations per status, largest first. */
	byStatus: ReadonlyArray<{ status: string; count: number }>
	/** Invocations that did not end in success. */
	failures: number
	exceptions: number
}

export function workerOutcomeTotals(
	buckets: ReadonlyArray<CloudflareWorkerOutcomeBucket>,
): WorkerOutcomeTotals {
	const counts = new Map<string, number>()
	for (const b of buckets) counts.set(b.status, (counts.get(b.status) ?? 0) + b.requests)
	const byStatus = [...counts]
		.map(([status, count]) => ({ status, count }))
		.toSorted((a, b) => b.count - a.count)
	const invocations = byStatus.reduce((acc, row) => acc + row.count, 0)
	return {
		invocations,
		byStatus,
		failures: invocations - (counts.get("success") ?? 0),
		exceptions: counts.get("scriptThrewException") ?? 0,
	}
}

/** All invocations per bucket, one line. */
export function invocationRows(buckets: ReadonlyArray<CloudflareWorkerOutcomeBucket>): StripRow[] {
	const totals = new Map<string, number>()
	for (const b of buckets) totals.set(b.bucket, (totals.get(b.bucket) ?? 0) + b.requests)
	return [...totals].map(([bucket, value]) => ({ bucket, attributeValue: "", value }))
}

/**
 * Non-success invocations per bucket, one line per way of failing. Buckets where a status didn't
 * occur are zero, not missing: the poller only writes rows for outcomes that happened, and a line
 * that stops after its last failure reads as "no data" rather than "no failures".
 */
export function failureRows(buckets: ReadonlyArray<CloudflareWorkerOutcomeBucket>): StripRow[] {
	const allBuckets = [...new Set(buckets.map((b) => b.bucket))].toSorted()
	const failing = [...new Set(buckets.filter((b) => b.status !== "success").map((b) => b.status))]
	const counts = new Map(buckets.map((b) => [`${b.bucket}|${b.status}`, b.requests]))
	return failing.flatMap((status) =>
		allBuckets.map((bucket) => ({
			bucket,
			attributeValue: outcomeLabel(status),
			value: counts.get(`${bucket}|${status}`) ?? 0,
		})),
	)
}

/** p99 and p50 lines; the series names pick up the shared percentile colours. */
export function percentileRows(
	buckets: ReadonlyArray<CloudflareWorkerLatencyBucket>,
	pick: (b: CloudflareWorkerLatencyBucket) => readonly [p50: number, p99: number],
): StripRow[] {
	return buckets.flatMap((b) => {
		const [p50, p99] = pick(b)
		return p99 > 0
			? [
					{ bucket: b.bucket, attributeValue: "p99", value: p99 },
					{ bucket: b.bucket, attributeValue: "p50", value: p50 },
				]
			: []
	})
}

export function durableObjectRows(buckets: ReadonlyArray<CloudflareWorkerDurableObjectBucket>): StripRow[] {
	return buckets.flatMap((b) => [
		{ bucket: b.bucket, attributeValue: "calls", value: b.requests },
		{ bucket: b.bucket, attributeValue: "errors", value: b.errors },
	])
}

/**
 * One marker per version first seen inside the window. A version already running when the window
 * opened reports the window start as its first span, which is not a deploy.
 */
export function deployMarkers(
	releases: ReadonlyArray<{ commitSha: string; firstSeen: string }>,
	windowStartIso: string,
	bucketSeconds: number,
): ChartEventMarker[] {
	const openedAt = new Date(windowStartIso).getTime() + bucketSeconds * 1000
	return releases
		.filter((release) => new Date(release.firstSeen).getTime() > openedAt)
		.toSorted((a, b) => a.firstSeen.localeCompare(b.firstSeen))
		.map((release) => ({
			id: release.commitSha,
			at: release.firstSeen,
			label: shortId(release.commitSha, "sha"),
			tone: "neutral",
		}))
}

/**
 * Exceptions Cloudflare counted that the Worker's own spans never recorded. Worth a callout only
 * when it is most of them: a few spans lost to sampling is not the same as failures tracing can't see.
 */
export function untracedExceptions(exceptions: number, tracedErrors: number | null): number | null {
	if (tracedErrors === null || exceptions === 0) return null
	return tracedErrors < exceptions / 2 ? exceptions - tracedErrors : null
}
