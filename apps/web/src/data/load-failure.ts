import { PublicHttpErrorBodySchema } from "@maple/domain/http"
import { displayError } from "@maple/web-data/lib/error-messages"

/**
 * A failed load as the Model keeps it: the public error body `displayError` derives from the
 * failure (title, message, recovery), which is everything `ErrorState` renders. Plain data, so it
 * rides in a Message and survives DevTools replay.
 */
export const LoadFailure = PublicHttpErrorBodySchema
export type LoadFailure = typeof LoadFailure.Type

/** Server outages read as one sentence; the title already names the subject. */
export const failureMessage = (failure: LoadFailure): string =>
	failure.type === "api_error" &&
	failure.retryable &&
	failure.recovery === "retry" &&
	!failure._tag.startsWith("@maple/web/errors/")
		? "Maple's backend is unavailable."
		: failure.message

export const toLoadFailure = (error: unknown): LoadFailure => {
	const failure = displayError(error)
	return { ...failure, message: failureMessage(failure) }
}

/** What a reader sees of a failure: two failures with one key read as the same message. */
export const failureKey = (failure: LoadFailure): string => `${failure.title}\n${failureMessage(failure)}`

export const isSameFailure = (a: LoadFailure, b: LoadFailure): boolean => failureKey(a) === failureKey(b)

/** Joins `failureKey`s; never part of a title or message. */
export const FAILURE_KEY_SEPARATOR = "\u0000"
