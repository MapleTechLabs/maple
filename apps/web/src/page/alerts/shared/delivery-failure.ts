import type { AnyPublicHttpErrorBody } from "@maple/domain/http"
import { Predicate } from "effect"

/**
 * A failed test send's toast text, with the provider's HTTP status when the failure carries one.
 * A failure the user fixes in settings (reconnect, update the target) keeps that advice.
 */
export const testSendFailureMessage = (
	failure: Pick<AnyPublicHttpErrorBody, "message" | "details" | "recovery">,
): string => {
	const status = failure.details?.provider_status
	if (!Predicate.isNumber(status)) return failure.message
	if (failure.recovery === "reconnect" || failure.recovery === "fix_request")
		return `${failure.message} (HTTP ${status})`
	return status >= 500
		? `The alert provider failed (HTTP ${status})`
		: `The alert provider rejected the request (HTTP ${status})`
}
