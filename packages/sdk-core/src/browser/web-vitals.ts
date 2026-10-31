// Core Web Vitals as log-based events, following the `browser.web_vital` event
// in the browser semantic conventions. Aggregates are derived in the warehouse,
// so each event keeps its page and the pageload trace it belongs to.
import { scrubUrl } from "@maple/browser-session"
import { type Metric, onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals"
import { type EmitLog, Severity, type SpanLink } from "../log-record"

// web-vitals has no unsubscribe: register once per page, and gate reporting instead.
let registered = false
/**
 * The path of the page view the metrics measure. web-vitals reports CLS, INP and
 * LCP for the whole document (often when it is hidden, long after an SPA moved
 * on), so the path is the document's, and a bfcache restore starts a new one.
 */
let pagePath = ""

function documentPath(): string {
	const [entry] = performance.getEntriesByType?.("navigation") ?? []
	try {
		if (entry?.name) return new URL(entry.name).pathname
	} catch {}
	return location.pathname
}
let emit: EmitLog | undefined
let pageload: (() => SpanLink | undefined) | undefined

function report(metric: Metric): void {
	emit?.({
		eventName: "browser.web_vital",
		severityNumber: Severity.INFO,
		severityText: "INFO",
		attributes: {
			"browser.web_vital.name": metric.name.toLowerCase(),
			"browser.web_vital.value": metric.value,
			"browser.web_vital.delta": metric.delta,
			"browser.web_vital.id": metric.id,
			"browser.web_vital.rating": metric.rating,
			"browser.web_vital.navigation_type": metric.navigationType,
			"url.path": pagePath,
		},
		// Only the trace link needs a pageload span; tracing may be off, or the app not navigating yet.
		link: pageload?.(),
	})
}

/** Report vitals through `sink`, linked to the document's pageload span when there is one. Returns a stop. */
export function startWebVitals(sink: EmitLog, getPageload: () => SpanLink | undefined): () => void {
	emit = sink
	pageload = getPageload
	if (!registered) {
		registered = true
		pagePath = scrubUrl(documentPath())
		window.addEventListener("pageshow", (event) => {
			if (event.persisted) pagePath = scrubUrl(location.pathname)
		})
		for (const on of [onCLS, onFCP, onINP, onLCP, onTTFB]) on(report)
	}
	return () => {
		if (emit !== sink) return
		emit = undefined
		pageload = undefined
	}
}
