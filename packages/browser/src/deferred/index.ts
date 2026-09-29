// Everything that can start a moment after `init()` without losing data lives
// behind this chunk, so it stays off the eager bundle every page load pays for.
import type { SpanContext } from "@opentelemetry/api"
import type { ResolvedConfig } from "../config"
import { onErrorRecorded } from "../errors"
import { onDocumentPageload } from "../navigation"
import { flushBreadcrumbs, startBreadcrumbs } from "./breadcrumbs"
import { recordDocumentTiming } from "./document-timing"
import { startLogs } from "./logs"
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
	const stops = [
		startLogs(config),
		async () => {
			stopVitals()
			onDocumentPageload(undefined)
			stopErrorListener()
			stopBreadcrumbs()
			stopReports()
		},
	]
	return async () => {
		await Promise.all(stops.map((stop) => stop()))
	}
}
