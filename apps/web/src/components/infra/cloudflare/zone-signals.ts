import type {
	CloudflareZoneCacheBucket,
	CloudflareZoneLatencyBucket,
	CloudflareZoneStatusBucket,
} from "@maple/web-data/warehouse/cloudflare-infra"
import { EDGE_SERVED_STATUSES } from "./constants"

type StripRow = { bucket: string; attributeValue: string; value: number }

const EDGE_SERVED = new Set(EDGE_SERVED_STATUSES.map((s) => s.status))
// Traffic Cloudflare was never going to cache. A hit rate over it measures the
// app's routing, not the cache, which is how an API zone read "0.1% cache hit".
const UNCACHEABLE = new Set(["none", "dynamic", "bypass", "unknown"])

const sumBy = <T>(rows: ReadonlyArray<T>, key: (row: T) => string, value: (row: T) => number) => {
	const out = new Map<string, number>()
	for (const row of rows) out.set(key(row), (out.get(key(row)) ?? 0) + value(row))
	return out
}

export interface ZoneSignalTotals {
	requests: number
	clientErrors: number
	serverErrors: number
	/** 4xx share of requests, 0-1. */
	clientErrorRate: number
	/** 5xx share of requests, 0-1. */
	serverErrorRate: number
	/** Edge-served share of cacheable requests, 0-1; null when nothing was cacheable. */
	cacheHitRate: number | null
	/** Cacheable share of all requests, 0-1. */
	cacheableShare: number
}

export function zoneSignalTotals(
	statusBuckets: ReadonlyArray<CloudflareZoneStatusBucket>,
	cacheBuckets: ReadonlyArray<CloudflareZoneCacheBucket>,
): ZoneSignalTotals {
	const byClass = sumBy(
		statusBuckets,
		(b) => b.statusClass,
		(b) => b.requests,
	)
	const requests = [...byClass.values()].reduce((a, b) => a + b, 0)
	const clientErrors = byClass.get("4xx") ?? 0
	const serverErrors = byClass.get("5xx") ?? 0

	const byCache = sumBy(
		cacheBuckets,
		(b) => b.cacheStatus,
		(b) => b.requests,
	)
	let cacheable = 0
	let served = 0
	let cacheTotal = 0
	for (const [status, count] of byCache) {
		cacheTotal += count
		if (UNCACHEABLE.has(status)) continue
		cacheable += count
		if (EDGE_SERVED.has(status)) served += count
	}

	return {
		requests,
		clientErrors,
		serverErrors,
		clientErrorRate: requests > 0 ? clientErrors / requests : 0,
		serverErrorRate: requests > 0 ? serverErrors / requests : 0,
		cacheHitRate: cacheable > 0 ? served / cacheable : null,
		cacheableShare: cacheTotal > 0 ? cacheable / cacheTotal : 0,
	}
}

/**
 * Requests per bucket, one line per status class. Not stacked: a stack's top edge is whichever
 * class sits last, so a zone that is 94% 4xx read as a green 2xx curve.
 */
export function requestRows(statusBuckets: ReadonlyArray<CloudflareZoneStatusBucket>): StripRow[] {
	return statusBuckets.map((b) => ({ bucket: b.bucket, attributeValue: b.statusClass, value: b.requests }))
}

/** 4xx and 5xx share of each bucket's requests, 0-1. Empty buckets are skipped, not zeroed. */
export function errorShareRows(statusBuckets: ReadonlyArray<CloudflareZoneStatusBucket>): StripRow[] {
	const buckets = new Map<string, { total: number; client: number; server: number }>()
	for (const b of statusBuckets) {
		const entry = buckets.get(b.bucket) ?? { total: 0, client: 0, server: 0 }
		entry.total += b.requests
		if (b.statusClass === "4xx") entry.client += b.requests
		if (b.statusClass === "5xx") entry.server += b.requests
		buckets.set(b.bucket, entry)
	}
	return [...buckets].flatMap(([bucket, { total, client, server }]) =>
		total === 0
			? []
			: [
					{ bucket, attributeValue: "4xx", value: client / total },
					{ bucket, attributeValue: "5xx", value: server / total },
				],
	)
}

/** Edge-served share of each bucket's cacheable requests; buckets with nothing cacheable are skipped. */
export function cacheHitRows(cacheBuckets: ReadonlyArray<CloudflareZoneCacheBucket>): StripRow[] {
	const buckets = new Map<string, { cacheable: number; served: number }>()
	for (const b of cacheBuckets) {
		if (UNCACHEABLE.has(b.cacheStatus)) continue
		const entry = buckets.get(b.bucket) ?? { cacheable: 0, served: 0 }
		entry.cacheable += b.requests
		if (EDGE_SERVED.has(b.cacheStatus)) entry.served += b.requests
		buckets.set(b.bucket, entry)
	}
	return [...buckets].flatMap(([bucket, { cacheable, served }]) =>
		cacheable === 0 ? [] : [{ bucket, attributeValue: "", value: served / cacheable }],
	)
}

/** TTFB and origin p99 per bucket. Empty when the zone's plan exposes no latency quantiles. */
export function latencyRows(latencyBuckets: ReadonlyArray<CloudflareZoneLatencyBucket>): StripRow[] {
	return latencyBuckets.flatMap((b) =>
		b.ttfbP99Ms > 0 || b.originP99Ms > 0
			? [
					{ bucket: b.bucket, attributeValue: "TTFB p99", value: b.ttfbP99Ms },
					{ bucket: b.bucket, attributeValue: "Origin p99", value: b.originP99Ms },
				]
			: [],
	)
}
