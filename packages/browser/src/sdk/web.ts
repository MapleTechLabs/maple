// What the fetch and XHR instrumentations share: URL handling, header
// propagation rules, and resource-timing network events, as OTel JS web-common.
import { context, diag, type HrTime, propagation, type Span, type Tracer, trace } from "@opentelemetry/api"
import { hrTime } from "./time"

/** How long a request span stays open after its response, waiting on its resource timing entry. */
export const OBSERVER_WAIT_TIME_MS = 300

export interface RequestInstrumentationConfig {
	/** Requests to matching URLs get no span. */
	readonly ignoreUrls: ReadonlyArray<RegExp>
	/** Cross-origin URLs that may receive `traceparent`; same-origin ones always do. */
	readonly propagateTraceHeaderCorsUrls: ReadonlyArray<RegExp>
	readonly tracer: Tracer
}

export function parseUrl(url: string): URL {
	return new URL(url, typeof document !== "undefined" ? document.baseURI : globalThis.location?.href)
}

export const isUrlIgnored = (url: string, ignored: ReadonlyArray<RegExp>): boolean =>
	ignored.some((pattern) => url.match(pattern) !== null)

export function shouldPropagateTraceHeaders(url: string, corsUrls: ReadonlyArray<RegExp>): boolean {
	return parseUrl(url).origin === globalThis.location?.origin || isUrlIgnored(url, corsUrls)
}

/** The active context's propagation headers; undefined when the URL may not receive them. */
export function traceHeaders(
	url: string,
	corsUrls: ReadonlyArray<RegExp>,
): Record<string, string> | undefined {
	if (!shouldPropagateTraceHeaders(url, corsUrls)) return undefined
	const headers: Record<string, string> = {}
	propagation.inject(context.active(), headers)
	return headers
}

const KNOWN_METHODS = new Set([
	"CONNECT",
	"DELETE",
	"GET",
	"HEAD",
	"OPTIONS",
	"PATCH",
	"POST",
	"PUT",
	"TRACE",
	"QUERY",
])

/** `http.request.method` and, when it differs, `http.request.method_original`. */
export function methodAttributes(method: string): Record<string, string> {
	const upper = method.toUpperCase()
	const normalized = KNOWN_METHODS.has(upper) ? upper : "_OTHER"
	return normalized === method
		? { "http.request.method": normalized }
		: { "http.request.method": normalized, "http.request.method_original": method }
}

const REDACTED_QUERY_KEYS = [
	"sig",
	"Signature",
	"AWSAccessKeyId",
	"X-Goog-Signature",
	"X-Amz-Signature",
	"X-Amz-Credential",
	"X-Amz-Security-Token",
]

function decodeQueryKey(key: string): string {
	try {
		return decodeURIComponent(key.replace(/\+/g, " "))
	} catch {
		return key
	}
}

/** Credentials and signed-URL query values replaced with `REDACTED`; anything else unchanged. */
export function redactUrl(url: string): string {
	const parsed = tryParse(url)
	if (!parsed) return url
	let redacted = false
	if (parsed.username || parsed.password) {
		parsed.username = "REDACTED"
		parsed.password = "REDACTED"
		redacted = true
	}
	if (parsed.search.length > 1) {
		let queryRedacted = false
		const pairs = parsed.search
			.slice(1)
			.split("&")
			.map((pair) => {
				const separator = pair.indexOf("=")
				const key = separator === -1 ? pair : pair.slice(0, separator)
				if (!REDACTED_QUERY_KEYS.includes(decodeQueryKey(key))) return pair
				queryRedacted = true
				return `${key}=REDACTED`
			})
		if (queryRedacted) {
			parsed.search = `?${pairs.join("&")}`
			redacted = true
		}
	}
	return redacted ? parsed.href : url
}

function tryParse(url: string): URL | undefined {
	try {
		return new URL(url)
	} catch {
		return undefined
	}
}

export function serverPort(url: URL): number | undefined {
	const port = Number(
		url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : ""),
	)
	return port !== 0 && !Number.isNaN(port) ? port : undefined
}

/** Replace `target[key]`; false when another script made it read-only (or the write did not take). */
export function tryReplace<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): boolean {
	try {
		target[key] = value
	} catch {
		return false
	}
	return target[key] === value
}

/** A hook the app or this SDK supplies; one that throws is logged, never surfaced. */
export function safely(name: string, run: () => void): void {
	try {
		run()
	} catch (error) {
		diag.error(name, error)
	}
}

type Timing = PerformanceResourceTiming

/** Collects the resource timing entries for `url` while a request is in flight. */
export function observeResources(
	url: string,
	initiatorType: string,
): { readonly entries: Timing[]; readonly startTime: HrTime; readonly disconnect: () => void } {
	const entries: Timing[] = []
	const startTime = hrTime()
	if (typeof PerformanceObserver !== "function") return { entries, startTime, disconnect: () => {} }
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			if (isResourceTiming(entry) && entry.initiatorType === initiatorType && entry.name === url) {
				entries.push(entry)
			}
		}
	})
	observer.observe({ entryTypes: ["resource"] })
	return { entries, startTime, disconnect: () => observer.disconnect() }
}

const isResourceTiming = (entry: PerformanceEntry): entry is Timing => entry.entryType === "resource"

const NETWORK_EVENTS = [
	"fetchStart",
	"domainLookupStart",
	"domainLookupEnd",
	"connectStart",
	"secureConnectionStart",
	"connectEnd",
	"requestStart",
	"responseStart",
	"responseEnd",
] as const

/** One event per resource timing mark, zeros skipped unless the entry starts at 0. */
function addNetworkEvents(span: Span, resource: Timing): void {
	const skipZeros = resource.startTime !== 0
	for (const name of NETWORK_EVENTS) {
		const value = resource[name]
		if (typeof value === "number" && !(skipZeros && value === 0)) span.addEvent(name, value)
	}
}

const nanos = (time: HrTime): number => time[0] * 1_000_000_000 + time[1]
const performanceNanos = (ms: number): number => nanos(hrTime(ms))

/**
 * The request's own timing entry, and the CORS preflight before it for a
 * cross-origin one, among entries no earlier span claimed.
 */
function findResource(
	url: string,
	startTime: HrTime,
	endTime: HrTime,
	resources: ReadonlyArray<Timing>,
	used: WeakSet<Timing>,
	initiatorType: string,
): { readonly main?: Timing | undefined; readonly preflight?: Timing | undefined } {
	const parsed = parseUrl(url)
	const href = parsed.toString()
	const start = nanos(startTime)
	const end = nanos(endTime)
	const matching = resources.filter(
		(resource) =>
			resource.initiatorType.toLowerCase() === initiatorType &&
			resource.name === href &&
			performanceNanos(resource.fetchStart) >= start &&
			performanceNanos(resource.responseEnd) <= end &&
			!used.has(resource),
	)
	if (matching.length <= 1 || parsed.origin === globalThis.location?.origin) return { main: matching[0] }
	const sorted = [...matching].sort((a, b) => a.fetchStart - b.fetchStart)
	const [preflight, ...rest] = sorted
	if (!preflight) return {}
	const minStart = performanceNanos(preflight.responseEnd)
	let main = rest[0]
	let bestGap: number | undefined
	for (const resource of rest) {
		const gap = end - performanceNanos(resource.responseEnd)
		if (
			performanceNanos(resource.fetchStart) >= minStart &&
			(bestGap === undefined || bestGap === 0 || gap < bestGap)
		) {
			bestGap = gap
			main = resource
		}
	}
	return main && main.fetchStart >= preflight.responseEnd ? { main, preflight } : { main: preflight }
}

/** Network events on `span` from its timing entry, and a `CORS Preflight` child span when there was one. */
export function addResourceTiming(
	tracer: Tracer,
	span: Span,
	request: { readonly url: string; readonly entries: Timing[]; readonly startTime: HrTime },
	endTime: HrTime,
	used: WeakSet<Timing>,
	initiatorType: string,
): void {
	const observed = request.entries
	const resources =
		observed.length > 0 || typeof performance.getEntriesByType !== "function"
			? observed
			: performance.getEntriesByType("resource").filter(isResourceTiming)
	const { main, preflight } = findResource(
		request.url,
		request.startTime,
		endTime,
		resources,
		used,
		initiatorType,
	)
	if (!main) return
	used.add(main)
	if (preflight) {
		used.add(preflight)
		const child = tracer.startSpan(
			"CORS Preflight",
			{ startTime: preflight.fetchStart },
			trace.setSpan(context.active(), span),
		)
		addNetworkEvents(child, preflight)
		child.end(preflight.responseEnd)
	}
	addNetworkEvents(span, main)
}
