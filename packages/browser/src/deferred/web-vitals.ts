// Core Web Vitals as OTel log-based events, following the `browser.web_vital`
// event in the browser semantic conventions. Aggregates are derived in the
// warehouse, so each event keeps its page and the pageload trace it belongs to.
import { scrubUrl } from "@maple/browser-session"
import type { SpanContext } from "@opentelemetry/api"
import { type Metric, onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals"
import { emitLog, Severity } from "../logs"

// web-vitals has no unsubscribe: register once per page, and gate reporting instead.
let registered = false
let reporting = false
let pageload: (() => SpanContext | undefined) | undefined

function report(metric: Metric): void {
	if (!reporting) return
	emitLog({
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
			"url.path": scrubUrl(location.pathname),
		},
		// Only the trace link needs a pageload span; tracing may be off, or the app not navigating yet.
		spanContext: pageload?.(),
	})
}

/** Report vitals, linked to the document's pageload span when there is one. Returns a stop. */
export function startWebVitals(getPageload: () => SpanContext | undefined): () => void {
	reporting = true
	pageload = getPageload
	if (!registered) {
		registered = true
		for (const on of [onCLS, onFCP, onINP, onLCP, onTTFB]) on(report)
	}
	return () => {
		reporting = false
		pageload = undefined
	}
}
