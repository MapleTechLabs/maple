// Everything that can start a moment after `init()` without losing data lives
// behind this chunk, so it stays off the eager bundle every page load pays for.
// The collectors are shared with the Effect SDK; this file adapts them to OTel.
import { hasConsent, ingestHeaders, sdkHint } from "@maple/browser-session"
import { claimPageSignal, onErrorRecorded, type PageSignal, type SpanLink } from "@maple/sdk-core"
import { flushBreadcrumbs, startBreadcrumbs } from "@maple/sdk-core/browser/breadcrumbs"
import { type RecordChild, recordDocumentTiming } from "@maple/sdk-core/browser/document-timing"
import { startOfflineQueue } from "@maple/sdk-core/browser/offline"
import { type StartSpan, startPerf } from "@maple/sdk-core/browser/perf"
import { startReports } from "@maple/sdk-core/browser/reports"
import { startWebVitals } from "@maple/sdk-core/browser/web-vitals"
import { context, type Span, trace, TraceFlags } from "@opentelemetry/api"
import { JsonLogsSerializer, JsonTraceSerializer } from "@opentelemetry/otlp-transformer"
import type { ResolvedConfig } from "../config"
import { emitLog } from "../logs"
import { navigationSpanAt, onDocumentPageload } from "../navigation"
import { attachSpanStash } from "../offline"
import { liveMapleTracer } from "../tracing"
import { SDK_NAME, SDK_VERSION } from "../version"
import { startLogs } from "./logs"

/** Jank spans nest under the navigation open when they began, on Maple's own provider. */
const perfSpan: StartSpan = (name, startMs, endMs, attributes) => {
	const tracer = hasConsent() ? liveMapleTracer(SDK_NAME, SDK_VERSION) : undefined
	if (!tracer) return
	const navigation = navigationSpanAt(startMs)
	const parent = navigation ? trace.setSpan(context.active(), navigation) : context.active()
	tracer.startSpan(name, { startTime: startMs, attributes }, parent).end(endMs)
}

/** Page signals this copy leased; another Maple SDK copy may already collect the rest. */
function leaseSignals(wanted: Record<PageSignal, boolean>): {
	readonly has: (signal: PageSignal) => boolean
	readonly release: () => void
} {
	const releases = new Map<PageSignal, () => void>()
	for (const signal of PAGE_SIGNALS) {
		const release = wanted[signal] ? claimPageSignal(signal) : undefined
		if (release) releases.set(signal, release)
	}
	return {
		has: (signal) => releases.has(signal),
		release: () => {
			for (const release of releases.values()) release()
		},
	}
}

const PAGE_SIGNALS: ReadonlyArray<PageSignal> = [
	"breadcrumbs",
	"browserReports",
	"console",
	"csp",
	"longFrames",
	"slowInteractions",
	"webVitals",
]

export function startDeferred(config: ResolvedConfig): () => Promise<void> {
	let pageload: SpanLink | undefined
	onDocumentPageload((tracer, span) => {
		pageload = span.spanContext()
		// Sampled, not recording: the app has usually ended the span by the time this chunk lands.
		if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) return
		const child: RecordChild<Span> = (parent, name, startMs, endMs, attributes) => {
			const next = tracer.startSpan(
				name,
				{ startTime: startMs, attributes },
				trace.setSpan(context.active(), parent),
			)
			next.end(endMs)
			return next
		}
		recordDocumentTiming(child, span)
	})
	const leased = leaseSignals({
		webVitals: config.webVitals,
		breadcrumbs: config.breadcrumbs,
		console: config.captureConsole.length > 0,
		csp: config.reportCsp,
		browserReports: config.reportBrowser,
		longFrames: config.longFrames,
		slowInteractions: config.slowInteractions,
	})
	const stopVitals = leased.has("webVitals") ? startWebVitals(emitLog, () => pageload) : () => {}
	const stopBreadcrumbs = startBreadcrumbs(emitLog, {
		breadcrumbs: leased.has("breadcrumbs"),
		captureConsole: leased.has("console") ? config.captureConsole : [],
	})
	const stopErrorListener = onErrorRecorded(flushBreadcrumbs)
	const stopReports = startReports(emitLog, {
		csp: leased.has("csp"),
		browserReports: leased.has("browserReports"),
	})
	const stopPerf = startPerf(perfSpan, {
		longFrames: leased.has("longFrames"),
		slowInteractions: leased.has("slowInteractions"),
	})
	const offline = config.offlineQueue
		? startOfflineQueue({
				endpoint: config.endpoint,
				headers: ingestHeaders({ ingestKey: config.ingestKey, sdk: sdkHint(SDK_NAME, SDK_VERSION) }),
			})
		: undefined
	attachSpanStash(
		offline &&
			((spans) => {
				const body = spans.length > 0 ? JsonTraceSerializer.serializeRequest(spans) : undefined
				if (body) offline.stash("traces", body)
			}),
	)
	const stopLogs = startLogs(
		config,
		offline &&
			((logs) => {
				const body = logs.length > 0 ? JsonLogsSerializer.serializeRequest(logs) : undefined
				if (body) offline.stash("logs", body)
			}),
	)
	return async () => {
		stopVitals()
		onDocumentPageload(undefined)
		stopErrorListener()
		stopBreadcrumbs()
		stopReports()
		stopPerf()
		leased.release()
		// The logs' last flush may fail into the offline queue, so it closes after them.
		await stopLogs()
		attachSpanStash(undefined)
		offline?.stop()
	}
}
