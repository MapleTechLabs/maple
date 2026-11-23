import { makeClientErrorBody } from "@maple/web-data/lib/error-messages"
import type { LoadFailure } from "@maple/views/data/load-failure"

/**
 * A request the API refused with its own words (a 400 validation or a 403), kept as a LoadFailure
 * so its message shows; those errors are not public bodies, so `settleTo` would read them as unexpected.
 */
export const refusalFailure = (title: string, message: string): LoadFailure =>
	makeClientErrorBody({
		_tag: "@maple/web/errors/Refused",
		code: "request_refused",
		title,
		message,
		retryable: false,
		recovery: "none",
	})
