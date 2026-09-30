// Everything that can start a moment after `init()` without losing data lives
// behind this chunk, so it stays off the eager bundle every page load pays for.
import type { SpanContext } from "@opentelemetry/api"
import type { ResolvedConfig } from "../config"
import { onErrorRecorded } from "../errors"
import { onDocumentPageload } from "../navigation"
import { attachSpanStash } from "../offline"
import { flushBreadcrumbs, startBreadcrumbs } from "./breadcrumbs"
import { recordDocumentTiming } from "./document-timing"
import { startLogs } from "./logs"
import { startOfflineQueue } from "./offline"
import { startPerf } from "./perf"
import { startReports } from "./reports"
import { startWebVitals } from "./web-vitals"

export function startDeferred(config: ResolvedConfig): () => Promise<void> {
	let pageload: SpanContext | undefined
	onDocumentPageload((tracer, span) => {
		pageload = span.spanContext()
		recordDocumentTiming(tracer, span)
	})
	// Before the logs pipeline, so vitals reported on page hide are emitted before its flush listener runs.
	const stopVitals = config.webVitals ? startWebVitals(() => pageload) : () => {}
	const stopBreadcrumbs = startBreadcrumbs({
		breadcrumbs: config.breadcrumbs,
		captureConsole: config.captureConsole,
	})
	const stopErrorListener = onErrorRecorded(flushBreadcrumbs)
	const stopReports = startReports({ csp: config.reportCsp, browserReports: config.reportBrowser })
	const stopPerf = startPerf({ longFrames: config.longFrames, slowInteractions: config.slowInteractions })
	const offline = config.offlineQueue ? startOfflineQueue(config) : undefined
	attachSpanStash(offline?.stashSpans)
	const stops = [
		startLogs(config, offline?.stashLogs),
		async () => {
			stopVitals()
			onDocumentPageload(undefined)
			stopErrorListener()
			stopBreadcrumbs()
			stopReports()
			attachSpanStash(undefined)
			offline?.stop()
			stopPerf()
		},
	]
	return async () => {
		await Promise.all(stops.map((stop) => stop()))
	}
}
