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
 * Errors already recorded, by identity, with the trace each was last recorded
 * in. Module-level so the global handlers, `captureException` and `traced`
 * share it: a framework boundary that reports an error and then rethrows it
 * would otherwise produce two issues for one crash.
 */
let recorded = new WeakMap<object, string>()

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null

/** Whether this exact error object was already recorded. */
export const alreadyReported = (error: unknown): boolean => isObject(error) && recorded.has(error)

/** Test seam. */
export function resetReportedErrorsForTests(): void {
	recorded = new WeakMap()
}

/**
 * Mark `span` as failed by `error`. The exception event goes on the first span
 * in a trace that records this error object; a later one (an outer `traced`,
 * say) only takes the Error status, so one error stays one issue. Per trace,
 * not per process: a server shares module state across requests, and an error
 * object thrown again in another request is another failure. The error is
 * claimed only when the span is recording: before `init()` the tracer is a
 * no-op, and claiming it then would swallow the same error reported again once
 * tracing is live.
 */
export function recordFailure(span: Span, error: unknown): void {
	const normalized = asError(error)
	const traceId = span.spanContext().traceId
	if (!isObject(error) || recorded.get(error) !== traceId) {
		if (span.isRecording() && isObject(error)) recorded.set(error, traceId)
		span.recordException(normalized)
	}
	span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message })
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
