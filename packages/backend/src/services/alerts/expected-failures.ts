/**
 * Failures of the alerting ticks that are expected outcomes, not bugs. The tracer exports a span
 * failed entirely by one of them as `Ok`, so they stay off error tracking; each is still recorded
 * where its owner reads it (the destination's delivery row, the cost source's last error).
 * Kept free of heavy imports: the alerting Worker loads it at startup.
 */
import { Predicate } from "effect"

/** `providerErrorCode` of a delivery the destination's own plan refused (Linear's issue cap). */
export const DELIVERY_USAGE_LIMIT_CODE = "usage_limit"

const tagOf = (value: unknown): string | undefined =>
	Predicate.hasProperty(value, "_tag") && typeof value._tag === "string" ? value._tag : undefined

/** Whether `value` carries `key` set to `expected`. */
const hasField = (value: unknown, key: string, expected: string): boolean =>
	Predicate.hasProperty(value, key) && value[key] === expected

// BOUNDARY: the tracer hands over a cause's raw failure values.
export const isAnticipatedAlertingFailure = (error: unknown): boolean => {
	switch (tagOf(error)) {
		// Another tick re-claimed the rule and owns the rest of it.
		case "@maple/alerts/AlertRuleClaimLostError":
			return true
		// The customer's destination plan is full: only they can clear it.
		case "@maple/http/errors/AlertDeliveryRejectedError":
			return hasField(error, "providerErrorCode", DELIVERY_USAGE_LIMIT_CODE)
		// A provider pushing back: the source backs off and the Cost page says so.
		case "@maple/backend/cost/CostProviderError":
		case "@maple/backend/cost/CostSyncFailedError":
			return hasField(error, "reason", "rate_limited")
		default:
			return false
	}
}
