import { PublicHttpErrorBodySchema } from "@maple/domain/http"
import { displayError } from "@maple/web-data/lib/error-messages"

/**
 * A failed load as the Model keeps it: the public error body `displayError` derives from the
 * failure (title, message, recovery), which is everything `ErrorState` renders. Plain data, so it
 * rides in a Message and survives DevTools replay.
 */
export const LoadFailure = PublicHttpErrorBodySchema
export type LoadFailure = typeof LoadFailure.Type

/** The fixed failure sentences: one per class, so the same outage reads the same on every page. */
export const FAILURE_SENTENCE = {
	backend: "Maple's backend is unavailable.",
	warehouse: "Maple couldn't query your telemetry.",
	sync: "Live sync is unavailable.",
	unknown: "Maple hit an unexpected error.",
} as const

/** A transient failure Maple retries: a dropped, timed-out or failing backend or warehouse. */
export const isTransientOutage = (failure: LoadFailure): boolean =>
	failure.type === "api_error" && failure.retryable && failure.recovery === "retry"

/** Warehouse codes (`warehouse_unavailable`, `warehouse_query_failed`) name the query backend, not the API. */
export const isWarehouseFailure = (failure: LoadFailure): boolean => failure.code.startsWith("warehouse_")

/** Server outages read as one sentence; the title already names the subject. */
export const failureMessage = (failure: LoadFailure): string => {
	if (!isTransientOutage(failure)) return failure.message
	if (isWarehouseFailure(failure)) return FAILURE_SENTENCE.warehouse
	return failure._tag.startsWith("@maple/web/errors/") ? failure.message : FAILURE_SENTENCE.backend
}

export const toLoadFailure = (error: unknown): LoadFailure => {
	const failure = displayError(error)
	return { ...failure, message: failureMessage(failure) }
}

/** What a reader sees of a failure: two failures with one key read as the same message. */
export const failureKey = (failure: LoadFailure): string => `${failure.title}\n${failureMessage(failure)}`

export const isSameFailure = (a: LoadFailure, b: LoadFailure): boolean => failureKey(a) === failureKey(b)

/** Joins `failureKey`s; never part of a title or message. */
export const FAILURE_KEY_SEPARATOR = "\u0000"
