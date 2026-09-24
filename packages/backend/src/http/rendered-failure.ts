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

/** Enough of a message to name the failure; a ClickHouse error carries the whole query. */
const MAX_MESSAGE_ATTRIBUTE_CHARS = 1_000

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
 * The one seam every renderer goes through. The diagnosis rides the span, not only the log: spans
 * reach the warehouse when a request's logs do not, and error tracking fingerprints on
 * `exception.type`. A 5xx span with no exception event was therefore rendered below this seam.
 */
export const recordRenderedFailure = (failure: RenderedFailure): Effect.Effect<void> =>
	Effect.gen(function* () {
		// The message rides as an attribute as well as on the exception event:
		// nothing in Maple reads span events back yet, and a 500 whose only
		// diagnosis is an event is a 500 with none.
		yield* Effect.annotateCurrentSpan({
			"error.type": failure.errorType,
			"error.message": failure.message.slice(0, MAX_MESSAGE_ATTRIBUTE_CHARS),
			"http.response.status_code": failure.status,
			"maple.failure.summary": failure.summary,
			"maple.failure.operation": `${failure.group}.${failure.operation}`,
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
