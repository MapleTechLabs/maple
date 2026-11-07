import type { AnyPublicHttpErrorBody } from "@maple/domain/http"
import { Predicate } from "effect"

/** A failed test send's toast text: the provider's HTTP status when the failure carries one. */
export const testSendFailureMessage = (
	failure: Pick<AnyPublicHttpErrorBody, "message" | "details">,
): string => {
	const status = failure.details?.provider_status
	if (!Predicate.isNumber(status)) return failure.message
	return status >= 500
		? `The alert provider failed (HTTP ${status})`
		: `The alert provider rejected the request (HTTP ${status})`
}
