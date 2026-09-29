// Everything that can start a moment after `init()` without losing data lives
// behind this chunk, so it stays off the eager bundle every page load pays for.
import type { SpanContext } from "@opentelemetry/api"
import type { ResolvedConfig } from "../config"
import { onDocumentPageload } from "../navigation"
import { recordDocumentTiming } from "./document-timing"
import { startLogs } from "./logs"
import { startWebVitals } from "./web-vitals"

export function startDeferred(config: ResolvedConfig): () => Promise<void> {
	let pageload: SpanContext | undefined
	onDocumentPageload((tracer, span) => {
		pageload = span.spanContext()
		recordDocumentTiming(tracer, span)
	})
	// Before the logs pipeline, so vitals reported on page hide are emitted before its flush listener runs.
	const stopVitals = config.webVitals ? startWebVitals(() => pageload) : () => {}
	const stops = [
		startLogs(config),
		async () => {
			stopVitals()
			onDocumentPageload(undefined)
		},
	]
	return async () => {
		await Promise.all(stops.map((stop) => stop()))
	}
}
