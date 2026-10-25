import { PublicHttpErrorBodySchema } from "@maple/domain/http"
import { displayError } from "@maple/web-data/lib/error-messages"

/**
 * A failed load as the Model keeps it: the public error body `displayError` derives from the
 * failure (title, message, recovery), which is everything `ErrorState` renders. Plain data, so it
 * rides in a Message and survives DevTools replay.
 */
export const LoadFailure = PublicHttpErrorBodySchema
export type LoadFailure = typeof LoadFailure.Type

export const toLoadFailure = (error: unknown): LoadFailure => displayError(error)

/** What a reader sees of a failure: two failures with one key read as the same message. */
export const failureKey = (failure: LoadFailure): string => `${failure.title}\n${failure.message}`

export const isSameFailure = (a: LoadFailure, b: LoadFailure): boolean => failureKey(a) === failureKey(b)

/** Joins `failureKey`s; never part of a title or message. */
export const FAILURE_KEY_SEPARATOR = "\u0000"
