// Uncaught-error capture.
//
// Everything else this SDK exports traces something it was asked to trace: a
// fetch, a session, a custom event. An error thrown outside all of that — a
// framework render crash, a throw in an event handler, a floating rejected
// promise — had no path into Maple at all, which left the one signal a customer
// most wants from a browser SDK missing.
//
// Each error becomes a one-off span carrying an `exception` event and status
// Error. That is the shape `error_events_mv` fingerprints on, so these arrive in
// error tracking beside server-side errors rather than in a separate silo.
import { hasConsent, scrubUrl } from "@maple/browser-session"
import {
	asError,
	type ErrorSource,
	markReported,
	notifyErrorRecorded,
	resetPageForTests,
	wasReported,
} from "@maple/sdk-core"
import { context, INVALID_SPAN_CONTEXT, type Span, SpanKind, SpanStatusCode } from "@opentelemetry/api"
import { exceptionOf } from "./error-causes"
import { shouldCapture } from "./error-filters"
import { keepContext } from "./sampling"
import { liveMapleTracer } from "./tracing"
import { SDK_NAME, SDK_VERSION } from "./version"

export { onErrorRecorded } from "@maple/sdk-core"

export interface CaptureExceptionOptions {
	/** Span name. Default `"exception"`. */
	readonly name?: string | undefined
	/** Extra span attributes. */
	readonly attributes?: Record<string, string | number | boolean> | undefined
}

/**
 * Errors already reported, by identity, page-wide: a framework boundary that
 * reports an error and then rethrows it, or both Maple SDKs on one page, would
 * otherwise produce two issues for one crash.
 */
const alreadyReported = wasReported

/** Test seam. */
export function resetReportedErrorsForTests(): void {
	resetPageForTests()
	pending = []
	accepting = false
}

/**
 * Mark `span` as failed by `error`. The exception event goes on the first span
 * that records this error object; a later one (an outer `traced`, say) only
 * takes the Error status, so one error stays one issue. The error is claimed
 * only when the span is recording: before `init()` the tracer is a no-op, and
 * claiming it then would swallow the same error reported again once tracing is
 * live. Without consent the span is never exported, so the error is not claimed either.
 */
export function recordFailure(span: Span, error: unknown, normalized: Error = asError(error)): void {
	if (!alreadyReported(error)) {
		const exported = span.isRecording() && hasConsent()
		if (exported) markReported(error)
		span.recordException(exceptionOf(normalized))
		if (exported) notifyErrorRecorded(span.spanContext())
	}
	span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message })
}

interface RecordOptions {
	readonly source: ErrorSource
	/** The top frame's script URL, when the error has no frames of its own. */
	readonly filename?: string | undefined
	/** `beforeCapture` already ran. */
	readonly filtered?: boolean | undefined
	/** `asError(error)`, when the caller built a better one. */
	readonly normalized?: Error | undefined
	/** When it happened, for an error queued before `init()`. */
	readonly startTime?: number | undefined
}

/**
 * Record `error` on a one-off span, exported whatever the session's trace
 * sampling, unless the app's error filters drop it. Without tracing there is no
 * span, but a buffered replay still keeps itself for the error.
 */
function recordException(error: unknown, options: CaptureExceptionOptions, record: RecordOptions): void {
	if (!hasConsent()) return
	const normalized = record.normalized ?? asError(error)
	if (
		!record.filtered &&
		!shouldCapture(normalized, { source: record.source, originalError: error }, record.filename)
	) {
		return
	}
	// Maple's own provider only: before `init()` the global one may be the host app's.
	const tracer = liveMapleTracer(SDK_NAME, SDK_VERSION)
	if (!tracer) {
		// Not claimed: another Maple SDK on the page may still span it.
		notifyErrorRecorded(INVALID_SPAN_CONTEXT)
		return
	}
	const span = tracer.startSpan(
		options.name ?? "exception",
		{
			kind: SpanKind.INTERNAL,
			startTime: record.startTime,
			attributes: {
				...(typeof location !== "undefined" ? { "url.full": scrubUrl(location.href) } : undefined),
				...options.attributes,
			},
		},
		keepContext(context.active()),
	)
	recordFailure(span, error, normalized)
	span.end()
}

/** Held until `init()` starts capture; beyond this, the oldest are dropped. */
const MAX_PENDING = 30

interface PendingException {
	readonly error: unknown
	readonly options: CaptureExceptionOptions
	readonly at: number
}

let accepting = false
let pending: PendingException[] = []

/**
 * Record an error that no span was watching. Safe before `init()`: the call is
 * held (capped) and recorded when it runs. Reporting the same error object
 * twice records it once.
 */
export function captureException(error: unknown, options: CaptureExceptionOptions = {}): void {
	// A server shares module state across requests, so nothing is held there.
	if (typeof window === "undefined") return
	if (!accepting && !liveMapleTracer(SDK_NAME, SDK_VERSION)) {
		pending.push({ error, options, at: Date.now() })
		if (pending.length > MAX_PENDING) pending.shift()
		return
	}
	if (alreadyReported(error)) return
	recordException(error, options, { source: "captureException" })
}

/** Called by `init()` once tracing (if any) is up: records what was held, then records directly. */
export function openExceptionCapture(): void {
	accepting = true
	const held = pending
	pending = []
	for (const { error, options, at } of held) {
		if (alreadyReported(error)) continue
		recordException(error, options, { source: "captureException", startTime: at })
	}
}

/** Called by `shutdown()`: later calls are held for the next `init()`. */
export function closeExceptionCapture(): void {
	accepting = false
}

/** Whether the app's error filters keep `error`, for failures recorded on an existing span. */
export function passesErrorFilters(error: unknown): boolean {
	return shouldCapture(asError(error), { source: "captureException", originalError: error })
}

/** `captureException` for an error `passesErrorFilters` already let through: `beforeCapture` runs once. */
export function captureFilteredException(error: unknown, options: CaptureExceptionOptions = {}): void {
	if (alreadyReported(error)) return
	recordException(error, options, { source: "captureException", filtered: true })
}

/**
 * Register global handlers for uncaught errors and unhandled rejections.
 * Returns a teardown that removes them. With `record: false` (tracing or
 * `captureErrors` off) they record nothing and only tell the replay an error happened.
 */
export function setupErrorCapture(record = true): () => void {
	if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
		return () => {}
	}
	const handle = (error: unknown, options: CaptureExceptionOptions, recordOptions: RecordOptions): void => {
		if (record) recordException(error, options, recordOptions)
		else notifyUnrecorded(error, recordOptions)
	}

	// One error must not become two issues. The same throw can reach both
	// handlers (a rejected promise whose reason is later rethrown), and a host
	// app's own boundary may report it through `captureException` as well:
	// `alreadyReported` is shared with that path, and with the other Maple SDK.
	const onError = (event: ErrorEvent): void => {
		// A cross-origin script surfaces as a bare "Script error." with no error
		// object and no usable frames. It fingerprints to one meaningless issue
		// that buries the real ones; the fix is `crossorigin` on the script tag,
		// not a noisier error tracker.
		const error: unknown = event.error ?? (event.message && event.filename ? event.message : undefined)
		if (error === undefined || alreadyReported(error)) return
		const thrownError = event.error instanceof Error
		const filename = event.filename ? scrubUrl(event.filename) : undefined
		handle(
			error,
			{
				name: "browser.uncaught_error",
				attributes: {
					"maple.exception.source": "window.onerror",
					// `code.file.path` / `code.line.number` since semconv v1.34.0. Nothing
					// reads the names they replaced, so they are dropped rather than
					// dual-emitted: carrying both would put four near-identical rows on
					// every uncaught error in the attribute list.
					...(filename ? { "code.file.path": filename } : undefined),
					...(event.lineno ? { "code.line.number": event.lineno } : undefined),
					...(event.colno ? { "code.column.number": event.colno } : undefined),
				},
			},
			{
				source: "window.onerror",
				// A thrown Error carries its own frames; anything else only has the event's filename.
				filename: thrownError ? undefined : event.filename || undefined,
				normalized: thrownError ? undefined : withThrowSite(asError(error), filename, event),
			},
		)
	}

	const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
		if (alreadyReported(event.reason)) return
		handle(
			event.reason,
			{
				name: "browser.unhandled_rejection",
				attributes: { "maple.exception.source": "unhandledrejection" },
			},
			{ source: "unhandledrejection" },
		)
	}

	window.addEventListener("error", onError)
	window.addEventListener("unhandledrejection", onUnhandledRejection)
	return () => {
		window.removeEventListener("error", onError)
		window.removeEventListener("unhandledrejection", onUnhandledRejection)
	}
}

/** An error the app wants no span for still keeps a buffered replay, if the filters keep it. */
function notifyUnrecorded(error: unknown, record: RecordOptions): void {
	if (!hasConsent()) return
	const normalized = record.normalized ?? asError(error)
	if (!shouldCapture(normalized, { source: record.source, originalError: error }, record.filename)) return
	notifyErrorRecorded(INVALID_SPAN_CONTEXT)
}

/**
 * A thrown non-Error has no frames of its own, only the event's location. One
 * V8-style frame there makes it groupable by where it was thrown.
 */
function withThrowSite(error: Error, filename: string | undefined, event: ErrorEvent): Error {
	if (!filename || error.stack !== undefined) return error
	const position = [filename, event.lineno || undefined, event.colno || undefined]
		.filter((part) => part !== undefined)
		.join(":")
	const header = error.message ? `${error.name}: ${error.message}` : error.name
	Object.defineProperty(error, "stack", {
		value: `${header}\n    at ${position}`,
		writable: true,
		configurable: true,
	})
	return error
}
