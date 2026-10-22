import type { AlertEvaluationErrorKind } from "@maple/domain/http"
import { Predicate } from "effect"

// Errors that mean the rule's query itself is wrong, so the author has to change it.
const INVALID_QUERY_TAGS: ReadonlySet<string> = new Set([
	"@maple/http/errors/AlertValidationError",
	"@maple/http/errors/AlertRuleStoredConfigInvalidError",
	"@maple/http/errors/QueryEngineValidationError",
	"@maple/http/errors/RawSqlValidationError",
])

/** Why a check failed, from the error that failed it. */
export const evaluationErrorKind = (error: unknown): AlertEvaluationErrorKind => {
	if (Predicate.isTagged(error, "@maple/http/errors/WarehouseQuotaExceededError")) {
		return Predicate.hasProperty(error, "setting") && error.setting === "max_memory_usage"
			? "query_too_much_memory"
			: "query_too_slow"
	}
	return Predicate.hasProperty(error, "_tag") &&
		typeof error._tag === "string" &&
		INVALID_QUERY_TAGS.has(error._tag)
		? "invalid_query"
		: "other"
}

/** The query ran out of time or memory: a longer interval buys it a larger limit. */
export const isQueryLimitFailure = (kind: AlertEvaluationErrorKind): boolean =>
	kind === "query_too_slow" || kind === "query_too_much_memory"

/** Query limit failures in a row before the scheduler slows a rule down. */
export const SLOWDOWN_AFTER_LIMIT_FAILURES = 3
