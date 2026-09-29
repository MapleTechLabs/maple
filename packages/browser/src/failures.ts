// Recording failures on spans, shared by the browser and server entries.
//
// Depends on `@opentelemetry/api` only: the `/server` entry imports it, and
// must stay free of anything browser-only.
import { type Span, SpanStatusCode } from "@opentelemetry/api"

export interface TracedOptions {
	/** Return `false` for throws that aren't errors, like redirects or not-found. Default: every throw is an error. */
	// BOUNDARY: a thrown value is unparsed by definition; the app narrows it.
	readonly isFailure?: ((error: unknown) => boolean) | undefined
}

const asError = (value: unknown): Error => {
	if (value instanceof Error) return value
	if (typeof value === "string") return new Error(value)
	if (typeof value === "object" && value !== null) {
		const message = (value as { readonly message?: unknown }).message
		if (typeof message === "string") return new Error(message)
	}
	// A rejected promise can carry literally anything. `String` keeps a number or
	// a boolean legible; an unrenderable object still produces one grouped issue
	// rather than throwing inside the error handler.
	try {
		return new Error(String(value))
	} catch {
		return new Error("Unknown error")
	}
}

/**
 * Errors already recorded, by identity. Module-level so the global handlers,
 * `captureException` and `traced` share it: a framework boundary that reports
 * an error and then rethrows it would otherwise produce two issues for one
 * crash.
 *
 * Once per error object, on a server too, where this outlives requests. Per
 * trace would record an error again whenever it crosses into another trace, and
 * the browser loses the trace at every `await`. The cost is an error object
 * shared by many requests, like a memoized promise's rejection, recorded by
 * `traced` on the first only; the framework's own spans still record the rest.
 */
let reported = new WeakSet<object>()

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null

/** Whether this exact error object was already recorded. */
export const alreadyReported = (error: unknown): boolean => isObject(error) && reported.has(error)

/** Test seam. */
export function resetReportedErrorsForTests(): void {
	reported = new WeakSet()
}

/**
 * Mark `span` as failed by `error`. The exception event goes on the first span
 * that records this error object; a later one (an outer `traced`, say) only
 * takes the Error status, so one error stays one issue. The error is claimed
 * only when the span is recording: before `init()` the tracer is a no-op, and
 * claiming it then would swallow the same error reported again once tracing is
 * live.
 */
export function recordFailure(span: Span, error: unknown): void {
	const normalized = asError(error)
	if (!alreadyReported(error)) {
		if (span.isRecording() && isObject(error)) reported.add(error)
		span.recordException(normalized)
	}
	span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message })
}

/** `recordFailure`'s exception event alone, for a span whose status follows something else, like a response's. */
export function recordExceptionOnce(span: Span, error: unknown): void {
	if (alreadyReported(error)) return
	if (span.isRecording() && isObject(error)) reported.add(error)
	span.recordException(asError(error))
}

/** Run `fn` as `span`'s work: its result or error passes through unchanged, and the span ends either way. */
export async function runTraced<T>(span: Span, fn: () => Promise<T>, options: TracedOptions): Promise<T> {
	try {
		return await fn()
	} catch (error) {
		if (isFailure(options, error)) recordFailure(span, error)
		throw error
	} finally {
		span.end()
	}
}

/** `isFailure` is the app's code: if it throws, the original error still propagates. */
function isFailure(options: TracedOptions, error: unknown): boolean {
	try {
		return options.isFailure?.(error) ?? true
	} catch {
		return true
	}
}
