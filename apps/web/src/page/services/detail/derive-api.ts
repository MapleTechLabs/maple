import type { ApiBucket, ApiTotals, Endpoint, StatusRow } from "./model-tabs"

// Pure halves of the API tab: status mix, KPI figures, the responses chart, the non-2xx breakdown,
// the table filters and the drawer's latency distribution.

/** The counters a status mix is read from (an endpoint, a bucket or the totals). */
type StatusCounts = Readonly<{
	httpStatusCount: number
	http4xxCount: number
	http5xxCount: number
}>

export type StatusMix = Readonly<{ ok: number; client: number; server: number }>

/** Shares of 2xx (everything below 400), 4xx and 5xx; `null` when no span carried a status code. */
export const statusMix = (counts: StatusCounts): StatusMix | null =>
	counts.httpStatusCount <= 0
		? null
		: {
				client: counts.http4xxCount / counts.httpStatusCount,
				server: counts.http5xxCount / counts.httpStatusCount,
				ok: Math.max(0, 1 - (counts.http4xxCount + counts.http5xxCount) / counts.httpStatusCount),
			}

/** Rows sealed before the status counters existed read as unknown, not as "no errors". */
export const knownStatusMix = (
	counts: StatusCounts & Readonly<{ httpClassifiedSpanCount: number }>,
): StatusMix | null => (counts.httpClassifiedSpanCount <= 0 ? null : statusMix(counts))

/** Bytes are exact counts of stored spans; the sampling weight scales them like the request rate. */
const samplingScale = (totals: Readonly<{ spanCount: number; estimatedSpanCount: number }>) =>
	totals.spanCount > 0 ? totals.estimatedSpanCount / totals.spanCount : 1

export type ApiKpis = Readonly<{
	requestsPerSecond: number
	totalRequests: number
	mix: StatusMix | null
	p95DurationMs: number
	/** p95 against the previous window of the same length, as a fraction; `null` without one. */
	p95Change: number | null
	bytesPerSecond: number | null
	avgBodyBytes: number | null
}>

export const apiKpis = (totals: ApiTotals, previous: ApiTotals | null, seconds: number): ApiKpis => ({
	requestsPerSecond: seconds > 0 ? totals.estimatedSpanCount / seconds : 0,
	totalRequests: totals.estimatedSpanCount,
	mix: knownStatusMix(totals),
	p95DurationMs: totals.p95DurationMs,
	p95Change:
		previous === null || previous.p95DurationMs <= 0 || previous.spanCount === 0
			? null
			: (totals.p95DurationMs - previous.p95DurationMs) / previous.p95DurationMs,
	bytesPerSecond:
		totals.requestBodyCount === 0 || seconds <= 0
			? null
			: (totals.requestBodyBytes * samplingScale(totals)) / seconds,
	avgBodyBytes: totals.requestBodyCount === 0 ? null : totals.requestBodyBytes / totals.requestBodyCount,
})

/** One series per KPI tile, in bucket order. */
export const kpiSparks = (buckets: ReadonlyArray<ApiBucket>, bucketSeconds: number) => ({
	requests: buckets.map((bucket) => bucket.estimatedSpanCount / Math.max(1, bucketSeconds)),
	client: buckets.map((bucket) => statusMix(bucket)?.client ?? 0),
	server: buckets.map((bucket) => statusMix(bucket)?.server ?? 0),
	p95: buckets.map((bucket) => bucket.p95DurationMs),
	bytes: buckets.map((bucket) => bucket.requestBodyBytes / Math.max(1, bucketSeconds)),
})

export const STATUS_CLASSES = ["2xx", "4xx", "5xx"] as const
export type StatusClass = (typeof STATUS_CLASSES)[number]

/** The responses chart's long rows: each bucket's request rate split by status class. */
export const responseRows = (buckets: ReadonlyArray<ApiBucket>, bucketSeconds: number) =>
	buckets.flatMap((bucket) => {
		const rate = bucket.estimatedSpanCount / Math.max(1, bucketSeconds)
		const mix = statusMix(bucket) ?? { ok: 1, client: 0, server: 0 }
		return [
			{ bucket: bucket.bucket, attributeValue: "2xx", value: rate * mix.ok },
			{ bucket: bucket.bucket, attributeValue: "4xx", value: rate * mix.client },
			{ bucket: bucket.bucket, attributeValue: "5xx", value: rate * mix.server },
		]
	})

/** Status-code reason phrases the breakdown names; unknown codes print bare. */
const REASON_PHRASES = new Map<string, string>([
	["400", "Bad Request"],
	["401", "Unauthorized"],
	["402", "Payment Required"],
	["403", "Forbidden"],
	["404", "Not Found"],
	["405", "Method Not Allowed"],
	["408", "Request Timeout"],
	["409", "Conflict"],
	["410", "Gone"],
	["413", "Content Too Large"],
	["415", "Unsupported Media Type"],
	["422", "Unprocessable Content"],
	["429", "Too Many Requests"],
	["499", "Client Closed Request"],
	["500", "Internal Server Error"],
	["501", "Not Implemented"],
	["502", "Bad Gateway"],
	["503", "Service Unavailable"],
	["504", "Gateway Timeout"],
])

export const reasonPhrase = (code: string): string => REASON_PHRASES.get(code) ?? ""

export const isServerError = (code: string) => code.startsWith("5")

/** Codes 400 and up; 1xx-3xx are what the breakdown leaves out. */
const isNonOk = (code: string) => Number(code) >= 400

type Ranked = ReadonlyArray<Readonly<{ name: string; count: number }>>

const ranked = (counts: ReadonlyMap<string, number>): Ranked =>
	[...counts].map(([name, count]) => ({ name, count })).toSorted((a, b) => b.count - a.count)

const add = (map: Map<string, number>, key: string, count: number) => map.set(key, (map.get(key) ?? 0) + count)

export type StatusCodeSummary = Readonly<{
	code: string
	count: number
	/** Share of every non-2xx response in the window. */
	share: number
	/** `error.type` values, most frequent first; empty values dropped. */
	errorTypes: Ranked
	/** Endpoints answering with this code, most frequent first. */
	routes: Ranked
}>

/** The non-2xx responses by status code, busiest first. */
export const statusCodeSummaries = (rows: ReadonlyArray<StatusRow>): ReadonlyArray<StatusCodeSummary> => {
	const groups = rows
		.filter((row) => isNonOk(row.httpStatusCode))
		.reduce((acc, row) => {
			const entry = acc.get(row.httpStatusCode) ?? {
				count: 0,
				errorTypes: new Map<string, number>(),
				routes: new Map<string, number>(),
			}
			entry.count += row.estimatedSpanCount
			if (row.errorType !== "") add(entry.errorTypes, row.errorType, row.estimatedSpanCount)
			add(entry.routes, row.spanName, row.estimatedSpanCount)
			return acc.set(row.httpStatusCode, entry)
		}, new Map<string, { count: number; errorTypes: Map<string, number>; routes: Map<string, number> }>())
	const total = [...groups.values()].reduce((sum, entry) => sum + entry.count, 0)
	return [...groups]
		.map(([code, entry]) => ({
			code,
			count: entry.count,
			share: total > 0 ? entry.count / total : 0,
			errorTypes: ranked(entry.errorTypes),
			routes: ranked(entry.routes),
		}))
		.toSorted((a, b) => b.count - a.count)
}

/** Every status code of one endpoint (2xx included), busiest first, with its share of the endpoint. */
export const endpointStatusCodes = (rows: ReadonlyArray<StatusRow>, spanName: string) => {
	const counts = rows
		.filter((row) => row.spanName === spanName)
		.reduce((acc, row) => add(acc, row.httpStatusCode, row.estimatedSpanCount), new Map<string, number>())
	const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
	return ranked(counts).map((entry) => ({ ...entry, share: total > 0 ? entry.count / total : 0 }))
}

/** "/v1/traces, /v1/logs +3": the leading routes of a code, by their path only. */
export const routeList = (routes: Ranked, shown = 2): string => {
	const paths = routes.slice(0, shown).map((route) => route.name.slice(route.name.indexOf(" ") + 1))
	const rest = routes.length - shown
	return rest > 0 ? `${paths.join(", ")} +${rest}` : paths.join(", ")
}

export const ENDPOINT_FILTERS = ["all", "rejecting", "slow"] as const
export type EndpointFilter = (typeof ENDPOINT_FILTERS)[number]

/** A response share above this marks an endpoint as rejecting. */
export const REJECTING_SHARE = 0.05
/** A p95 above this marks an endpoint as slow. */
export const SLOW_P95_MS = 100

export const ENDPOINT_FILTER_LABELS = {
	all: "All",
	rejecting: "Rejecting > 5%",
	slow: "p95 > 100ms",
} as const satisfies Record<EndpointFilter, string>

export const matchesFilter = (endpoint: Endpoint, filter: EndpointFilter, query: string): boolean => {
	const needle = query.trim().toLowerCase()
	if (needle !== "" && !endpoint.spanName.toLowerCase().includes(needle)) return false
	switch (filter) {
		case "all":
			return true
		case "rejecting": {
			const mix = knownStatusMix(endpoint)
			return mix !== null && mix.client + mix.server > REJECTING_SHARE
		}
		case "slow":
			return endpoint.p95DurationMs > SLOW_P95_MS
	}
}

/** The endpoint the "slowest" badge marks: the worst p95, when it is past the slow line. */
export const slowestEndpoint = (endpoints: ReadonlyArray<Endpoint>): string | null => {
	const worst = endpoints.reduce<Endpoint | null>(
		(acc, endpoint) => (acc === null || endpoint.p95DurationMs > acc.p95DurationMs ? endpoint : acc),
		null,
	)
	return worst !== null && worst.p95DurationMs > SLOW_P95_MS ? worst.spanName : null
}

export type HistogramBin = Readonly<{
	fromMs: number
	toMs: number
	/** Share of requests in the bin, 0-1. */
	share: number
	/** Which percentile band the bin's upper edge falls in, for its colour. */
	band: "p50" | "p95" | "p99"
}>

const HISTOGRAM_BINS = 10
const MIN_LATENCY_MS = 0.01

/**
 * The latency distribution from a few quantiles: log-spaced bins between the lowest and highest
 * quantile, each holding the probability mass the piecewise-linear (in log time) CDF puts in it.
 */
export const latencyHistogram = (
	levels: ReadonlyArray<number>,
	valuesMs: ReadonlyArray<number>,
): ReadonlyArray<HistogramBin> => {
	const points = levels
		.map((level, index) => ({ level, ms: Math.max(MIN_LATENCY_MS, valuesMs[index] ?? 0) }))
		.filter((point) => Number.isFinite(point.ms))
	const first = points[0]
	const last = points[points.length - 1]
	if (first === undefined || last === undefined || last.ms <= first.ms) return []
	const logOf = (ms: number) => Math.log10(Math.max(MIN_LATENCY_MS, ms))
	const cdf = (ms: number): number => {
		const x = logOf(ms)
		if (x <= logOf(first.ms)) return first.level
		if (x >= logOf(last.ms)) return last.level
		const upper = points.findIndex((point) => logOf(point.ms) >= x)
		const hi = points[upper]
		const lo = points[upper - 1]
		if (hi === undefined || lo === undefined) return last.level
		const span = logOf(hi.ms) - logOf(lo.ms)
		return span <= 0 ? hi.level : lo.level + ((x - logOf(lo.ms)) / span) * (hi.level - lo.level)
	}
	const quantileAt = (level: number) =>
		points.find((point) => point.level >= level)?.ms ?? last.ms
	const p95 = quantileAt(0.95)
	const p99 = quantileAt(0.99)
	const step = (logOf(last.ms) - logOf(first.ms)) / HISTOGRAM_BINS
	const mass = last.level - first.level
	return Array.from({ length: HISTOGRAM_BINS }, (_, index) => {
		const fromMs = 10 ** (logOf(first.ms) + step * index)
		const toMs = 10 ** (logOf(first.ms) + step * (index + 1))
		return {
			fromMs,
			toMs,
			share: mass > 0 ? (cdf(toMs) - cdf(fromMs)) / mass : 0,
			band: toMs <= p95 ? "p50" : toMs <= p99 ? "p95" : "p99",
		}
	})
}
