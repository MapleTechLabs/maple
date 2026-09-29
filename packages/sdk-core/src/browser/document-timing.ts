// The document's own load, as child spans of the `pageload` navigation: the
// response for the HTML (and its network phases), DOM processing, and the load
// event. Read from the Navigation Timing entry once the page has loaded.
import { scrubUrl } from "@maple/browser-session"

/**
 * Record one finished child of `parent` (epoch ms) and return it, so phases can
 * nest under it. Each SDK implements this on its own tracer.
 */
export type RecordChild<P> = (
	parent: P,
	name: string,
	startMs: number,
	endMs: number,
	attributes?: Record<string, string | number>,
) => P

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

function spanPhases<P>(
	child: RecordChild<P>,
	parent: P,
	entry: PerformanceNavigationTiming,
	phases: ReadonlyArray<Phase>,
): void {
	for (const [name, start, end] of phases) {
		const from = start(entry)
		const to = end(entry)
		// Zero marks are phases that did not happen: a reused connection has no dns or connect.
		if (from <= 0 || to <= from) continue
		child(parent, name, at(from), at(to))
	}
}

function record<P>(child: RecordChild<P>, pageload: P): void {
	const [entry] = performance.getEntriesByType("navigation")
	if (!(entry instanceof PerformanceNavigationTiming) || entry.responseEnd <= 0) return
	const fetch = child(pageload, "documentFetch", at(entry.fetchStart), at(entry.responseEnd), {
		"url.full": scrubUrl(entry.name),
		...(entry.responseStatus > 0 ? { "http.response.status_code": entry.responseStatus } : undefined),
		...(entry.encodedBodySize > 0 ? { "http.response.body.size": entry.encodedBodySize } : undefined),
	})
	spanPhases(child, fetch, entry, FETCH_PHASES)
	spanPhases(child, pageload, entry, PAGE_PHASES)
}

/** Span the document's load under `pageload`, now or once the `load` event has finished. */
export function recordDocumentTiming<P>(child: RecordChild<P>, pageload: P): void {
	if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return
	// A task after `load`, so `loadEventEnd` is set. Timing is best-effort: never throw into the page.
	const run = (): void =>
		void setTimeout(() => {
			try {
				record(child, pageload)
			} catch {}
		}, 0)
	if (document.readyState === "complete") run()
	else window.addEventListener("load", run, { once: true })
}
