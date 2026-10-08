import { Context, Effect, Exit, Option, Tracer } from "effect"

/**
 * Browser-side phase timing for API calls.
 *
 * The `http.client` span ends when response headers arrive, but the browser only
 * publishes a PerformanceResourceTiming entry once the body is read. So the phases
 * land on a child span, `http.client.timing`, parented through the request's
 * `traceparent` and placed at the entry's own start and end times.
 */

interface PendingFetch {
	readonly url: string
	readonly startedAt: number
	readonly traceId: string
	readonly spanId: string
	readonly sampled: boolean
	readonly authWaitMs: number | undefined
}

type Run = (effect: Effect.Effect<void>) => void

const MAX_PENDING = 200
const PENDING_TTL_MS = 120_000
// Entry and request start come from the same clock; this absorbs rounding.
const START_SLACK_MS = 1

let pending: Array<PendingFetch> = []
let run: Run | undefined

const parseTraceparent = (value: string | null) => {
	const parts = value?.split("-")
	if (parts?.length !== 4 || parts[1].length !== 32 || parts[2].length !== 16) return undefined
	return { traceId: parts[1], spanId: parts[2], sampled: parts[3] === "01" }
}

/** `url` as a resource entry names it: resolved against `base`, without a fragment. */
export const resourceEntryName = (url: string, base: string): string => {
	const resolved = URL.parse(url, base)
	if (resolved === null) return url
	resolved.hash = ""
	return resolved.href
}

/** Remember a sent request so its resource entry can be matched later. */
export const trackFetch = (options: {
	readonly url: string
	readonly startedAt: number
	readonly traceparent: string | null
	readonly authWaitMs: number | undefined
}): void => {
	if (run === undefined) return
	const parent = parseTraceparent(options.traceparent)
	if (parent === undefined) return
	if (pending.length >= MAX_PENDING) pending = pending.slice(1)
	pending.push({
		url: resourceEntryName(options.url, location.href),
		startedAt: options.startedAt,
		authWaitMs: options.authWaitMs,
		...parent,
	})
}

const ms = (value: number) => Math.max(0, Math.round(value * 10) / 10)

const protocolOf = (nextHop: string): Record<string, string> => {
	if (nextHop === "h2") return { "network.protocol.name": "http", "network.protocol.version": "2" }
	if (nextHop === "h3") return { "network.protocol.name": "http", "network.protocol.version": "3" }
	const http1 = /^http\/(1\.[01])$/.exec(nextHop)
	return http1 ? { "network.protocol.name": "http", "network.protocol.version": http1[1] } : {}
}

export type ResourceTimingPhases = Pick<
	PerformanceResourceTiming,
	| "startTime"
	| "duration"
	| "domainLookupStart"
	| "domainLookupEnd"
	| "connectStart"
	| "secureConnectionStart"
	| "connectEnd"
	| "requestStart"
	| "responseStart"
	| "responseEnd"
	| "nextHopProtocol"
	| "encodedBodySize"
>

/** Span attributes for one entry. Every phase reads 0 unless the response allowed timing. */
export const resourceTimingAttributes = (
	entry: ResourceTimingPhases,
	authWaitMs: number | undefined,
): Record<string, string | number | boolean> => {
	const auth: Record<string, number> =
		authWaitMs === undefined ? {} : { "maple.auth.wait_ms": ms(authWaitMs) }
	const base = { "maple.fetch.total_ms": ms(entry.duration), ...auth }
	if (entry.responseStart === 0) return { ...base, "maple.fetch.timing_allowed": false }
	const tlsStart = entry.secureConnectionStart > 0 ? entry.secureConnectionStart : entry.connectEnd
	const dns = ms(entry.domainLookupEnd - entry.domainLookupStart)
	const connect = ms(tlsStart - entry.connectStart)
	const tls = ms(entry.connectEnd - tlsStart)
	return {
		...base,
		"maple.fetch.timing_allowed": true,
		"maple.fetch.dns_ms": dns,
		"maple.fetch.connect_ms": connect,
		"maple.fetch.tls_ms": tls,
		// Time before the request went out that no named phase covers. Includes an
		// uncached CORS preflight round trip, plus queueing and connection-pool waits.
		"maple.fetch.stalled_ms": ms(entry.requestStart - entry.startTime - dns - connect - tls),
		"maple.fetch.ttfb_ms": ms(entry.responseStart - entry.requestStart),
		"maple.fetch.download_ms": ms(entry.responseEnd - entry.responseStart),
		"maple.fetch.next_hop_protocol": entry.nextHopProtocol,
		"http.response.body.size": entry.encodedBodySize,
		...protocolOf(entry.nextHopProtocol),
	}
}

const epochNanos = (relativeMs: number) =>
	BigInt(Math.round((performance.timeOrigin + relativeMs) * 1000)) * 1000n

const emitTimingSpan = (request: PendingFetch, entry: PerformanceResourceTiming) =>
	Effect.gen(function* () {
		const tracer = yield* Tracer.Tracer
		const span = tracer.span({
			name: "http.client.timing",
			parent: Option.some(Tracer.externalSpan(request)),
			annotations: Context.empty(),
			links: [],
			startTime: epochNanos(entry.startTime),
			kind: "internal",
			root: false,
			sampled: request.sampled,
		})
		Object.entries(resourceTimingAttributes(entry, request.authWaitMs)).forEach(([key, value]) =>
			span.attribute(key, value),
		)
		span.end(epochNanos(entry.responseEnd), Exit.void)
	})

/** Pops the tracked request this entry belongs to: same URL, closest start. */
const takeMatch = (entry: PerformanceResourceTiming): PendingFetch | undefined => {
	const now = performance.now()
	pending = pending.filter((request) => now - request.startedAt < PENDING_TTL_MS)
	const match = pending
		.filter(
			(request) => request.url === entry.name && request.startedAt <= entry.startTime + START_SLACK_MS,
		)
		.reduce<PendingFetch | undefined>(
			(best, request) =>
				best === undefined ||
				Math.abs(entry.startTime - request.startedAt) < Math.abs(entry.startTime - best.startedAt)
					? request
					: best,
			undefined,
		)
	if (match !== undefined) pending = pending.filter((request) => request !== match)
	return match
}

/** Starts matching resource entries to tracked API calls. Idempotent. */
export const startFetchTimingReporter = (runEffect: Run): void => {
	if (run !== undefined || typeof PerformanceObserver === "undefined") return
	if (!PerformanceObserver.supportedEntryTypes?.includes("resource")) return
	run = runEffect
	new PerformanceObserver((list) => {
		list.getEntriesByType("resource").forEach((entry) => {
			if (!(entry instanceof PerformanceResourceTiming) || entry.initiatorType !== "fetch") return
			const request = takeMatch(entry)
			if (request !== undefined) runEffect(emitTimingSpan(request, entry))
		})
	}).observe({ type: "resource" })
}
