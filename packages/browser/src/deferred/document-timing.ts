// The document's own load, as child spans of the `pageload` navigation: the
// response for the HTML (and its network phases), DOM processing, and the load
// event. Read from the Navigation Timing entry once the page has loaded.
import { scrubUrl } from "@maple/browser-session"
import { context, type Span, type Tracer, trace, TraceFlags } from "@opentelemetry/api"

type Mark = (entry: PerformanceNavigationTiming) => number
type Phase = readonly [name: string, start: Mark, end: Mark]

const FETCH_PHASES: ReadonlyArray<Phase> = [
	["dns", (e) => e.domainLookupStart, (e) => e.domainLookupEnd],
	["connect", (e) => e.connectStart, (e) => e.connectEnd],
	["request", (e) => e.requestStart, (e) => e.responseStart],
	["response", (e) => e.responseStart, (e) => e.responseEnd],
]

const PAGE_PHASES: ReadonlyArray<Phase> = [
	["domProcessing", (e) => e.responseEnd, (e) => e.domComplete],
	["loadEvent", (e) => e.loadEventStart, (e) => e.loadEventEnd],
]

/** Epoch ms for a Navigation Timing offset. */
const at = (offset: number): number => performance.timeOrigin + offset

function spanPhases(
	tracer: Tracer,
	parent: Span,
	entry: PerformanceNavigationTiming,
	phases: ReadonlyArray<Phase>,
): void {
	const ctx = trace.setSpan(context.active(), parent)
	for (const [name, start, end] of phases) {
		const from = start(entry)
		const to = end(entry)
		// Zero marks are phases that did not happen: a reused connection has no dns or connect.
		if (from <= 0 || to <= from) continue
		tracer.startSpan(name, { startTime: at(from) }, ctx).end(at(to))
	}
}

function record(tracer: Tracer, pageload: Span): void {
	const [entry] = performance.getEntriesByType("navigation")
	if (!(entry instanceof PerformanceNavigationTiming) || entry.responseEnd <= 0) return
	const fetch = tracer.startSpan(
		"documentFetch",
		{
			startTime: at(entry.fetchStart),
			attributes: {
				"url.full": scrubUrl(entry.name),
				...(entry.responseStatus > 0
					? { "http.response.status_code": entry.responseStatus }
					: undefined),
				...(entry.encodedBodySize > 0
					? { "http.response.body.size": entry.encodedBodySize }
					: undefined),
			},
		},
		trace.setSpan(context.active(), pageload),
	)
	spanPhases(tracer, fetch, entry, FETCH_PHASES)
	fetch.end(at(entry.responseEnd))
	spanPhases(tracer, pageload, entry, PAGE_PHASES)
}

/** Span the document's load under `pageload`, now or once the `load` event has finished. */
export function recordDocumentTiming(tracer: Tracer, pageload: Span): void {
	// Sampled, not recording: the app has usually ended the span by the time this chunk lands.
	const sampled = (pageload.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0
	if (!sampled || typeof performance.getEntriesByType !== "function") return
	// A task after `load`, so `loadEventEnd` is set. Timing is best-effort: never throw into the page.
	const run = (): void =>
		void setTimeout(() => {
			try {
				record(tracer, pageload)
			} catch {}
		}, 0)
	if (document.readyState === "complete") run()
	else window.addEventListener("load", run, { once: true })
}
