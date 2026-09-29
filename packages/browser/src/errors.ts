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
import { context, type Span, SpanKind, SpanStatusCode } from "@opentelemetry/api"
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
}

/**
 * Mark `span` as failed by `error`. The exception event goes on the first span
 * that records this error object; a later one (an outer `traced`, say) only
 * takes the Error status, so one error stays one issue. The error is claimed
 * only when the span is recording: before `init()` the tracer is a no-op, and
 * claiming it then would swallow the same error reported again once tracing is
 * live. Without consent the span is never exported, so the error is not claimed either.
 */
export function recordFailure(span: Span, error: unknown): void {
	const normalized = asError(error)
	if (!alreadyReported(error)) {
		const exported = span.isRecording() && hasConsent()
		if (exported) markReported(error)
		span.recordException(exceptionOf(normalized))
		if (exported) notifyErrorRecorded(span.spanContext())
	}
	span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message })
}

/**
 * Record `error` on a one-off span, exported whatever the session's trace
 * sampling, unless the app's error filters drop it.
 */
function recordException(
	error: unknown,
	options: CaptureExceptionOptions,
	source: ErrorSource,
	filename?: string,
	filtered = false,
): void {
	if (!hasConsent()) return
	if (!filtered && !shouldCapture(asError(error), { source, originalError: error }, filename)) return
	// Maple's own provider only: before `init()` the global one may be the host app's.
	const tracer = liveMapleTracer(SDK_NAME, SDK_VERSION)
	if (!tracer) return
	const span = tracer.startSpan(
		options.name ?? "exception",
		{
			kind: SpanKind.INTERNAL,
			attributes: {
				...(typeof location !== "undefined" ? { "url.full": scrubUrl(location.href) } : undefined),
				...options.attributes,
			},
		},
		keepContext(context.active()),
	)
	recordFailure(span, error)
	span.end()
}

/**
 * Record an error that no span was watching. Safe before `init()`, where it
 * does nothing. Reporting the same error object twice records it once.
 */
export function captureException(error: unknown, options: CaptureExceptionOptions = {}): void {
	if (alreadyReported(error)) return
	recordException(error, options, "captureException")
}

/** Whether the app's error filters keep `error`, for failures recorded on an existing span. */
export function passesErrorFilters(error: unknown): boolean {
	return shouldCapture(asError(error), { source: "captureException", originalError: error })
}

/** `captureException` for an error `passesErrorFilters` already let through: `beforeCapture` runs once. */
export function captureFilteredException(error: unknown, options: CaptureExceptionOptions = {}): void {
	if (alreadyReported(error)) return
	recordException(error, options, "captureException", undefined, true)
}

/**
 * Register global handlers for uncaught errors and unhandled rejections.
 * Returns a teardown that removes them.
 */
export function setupErrorCapture(): () => void {
	if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
		return () => {}
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
		const error: unknown =
			event.error ?? (event.message && event.filename ? new Error(event.message) : undefined)
		if (error === undefined || alreadyReported(error)) return
		recordException(
			error,
			{
				name: "browser.uncaught_error",
				attributes: {
					"maple.exception.source": "window.onerror",
					// `code.file.path` / `code.line.number` since semconv v1.34.0. Nothing
					// reads the names they replaced, so they are dropped rather than
					// dual-emitted — carrying both would put four near-identical rows on
					// every uncaught error in the attribute list.
					...(event.filename ? { "code.file.path": event.filename } : undefined),
					...(event.lineno ? { "code.line.number": event.lineno } : undefined),
					...(event.colno ? { "code.column.number": event.colno } : undefined),
				},
			},
			"window.onerror",
			// A thrown Error carries its own frames; anything else only has the event's filename.
			event.error instanceof Error ? undefined : event.filename || undefined,
		)
	}

	const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
		if (alreadyReported(event.reason)) return
		recordException(
			event.reason,
			{
				name: "browser.unhandled_rejection",
				attributes: { "maple.exception.source": "unhandledrejection" },
			},
			"unhandledrejection",
		)
	}

	window.addEventListener("error", onError)
	window.addEventListener("unhandledrejection", onUnhandledRejection)
	return () => {
		window.removeEventListener("error", onError)
		window.removeEventListener("unhandledrejection", onUnhandledRejection)
	}
}
