import { Clock, Effect } from "effect"

/** A failure at the moment the API turns it into a response. */
export interface RenderedFailure {
	readonly group: string
	readonly operation: string
	/** What error tracking groups this under — a domain `_tag`, or a defect's constructor name. */
	readonly errorType: string
	/** The log line: which of the four renderings this was. */
	readonly summary: string
	/** The failure's own message. */
	readonly message: string
	readonly status: number
	readonly stack?: string | undefined
	readonly detail?: ReadonlyArray<string> | undefined
	readonly cause: unknown
}

/** A defect's identity: an `Error` subclass by name, anything else by its `typeof`. */
export const failureTypeOf = (value: unknown): string => (value instanceof Error ? value.name : typeof value)

export const failureStackOf = (value: unknown): string | undefined =>
	value instanceof Error ? value.stack : undefined

/** The live span carries the diagnosis; no-ops on an untraced fiber. */
const recordException = (failure: RenderedFailure) =>
	Effect.gen(function* () {
		const at = yield* Clock.currentTimeNanos
		const span = yield* Effect.currentSpan
		span.event("exception", at, {
			"exception.type": failure.errorType,
			"exception.message": failure.message,
			...(failure.stack === undefined ? undefined : { "exception.stacktrace": failure.stack }),
		})
	}).pipe(Effect.ignore)

/**
 * Record a failure where it becomes a response — the one seam every renderer goes through.
 *
 * The API renders a failure in four places: an endpoint's declared 5xx, a route defect, a response
 * that failed its own schema, and a cause escaping the route graph. Each conversion is individually
 * correct and each one used to destroy what the next needed, so a crash reached the wire unnamed.
 *
 * The diagnosis goes on the span as a real `exception` event, not only into a log. Spans from a
 * request reach the warehouse when that request's logs do not, and error tracking fingerprints on
 * `exception.type` — so a 500 arrives under its own name instead of as one anonymous bucket. A 5xx
 * span carrying no exception event of its own was rendered below this seam, and the tracer labels
 * exactly those `HttpServerErrorResponse`.
 */
export const recordRenderedFailure = (failure: RenderedFailure): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			"error.type": failure.errorType,
			"http.response.status_code": failure.status,
		})
		yield* recordException(failure)
		yield* Effect.logError(failure.summary).pipe(
			Effect.annotateLogs({
				errorTag: failure.errorType,
				status: failure.status,
				group: failure.group,
				operation: failure.operation,
				message: failure.message,
				cause: failure.cause,
				...(failure.detail === undefined ? undefined : { details: failure.detail }),
			}),
		)
	})
