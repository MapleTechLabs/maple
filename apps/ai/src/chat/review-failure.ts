/**
 * Why a review pass stopped without a report, in the fixed vocabulary the pull request is shown.
 *
 * The raw cause stays in logs and spans; only the reason reaches GitHub, as the prefix of the error
 * the row stores (`time_limit: ...`), which `PrReviewService` turns back into one sentence.
 */
import { AgentPolicyError, ContextBudgetError, ContextOverflowError } from "@effect-agent/core/AgentError"
import { PR_REVIEW_FAILURE_COPY, type PrReviewFailureReason } from "@maple/domain/http"
import { Cause } from "effect"
import { isAiError } from "effect/unstable/ai/AiError"

/** The reason a failed run's cause names; anything unrecognized is an `agent_error`. */
export const reviewFailureReason = (cause: Cause.Cause<unknown>): PrReviewFailureReason => {
	const error = Cause.squash(cause)
	if (error instanceof AgentPolicyError) {
		switch (error.limit) {
			case "duration":
				return "time_limit"
			case "repeated-failures":
				return "stuck"
			default:
				return "step_limit"
		}
	}
	if (error instanceof ContextBudgetError || error instanceof ContextOverflowError) return "context_limit"
	if (isAiError(error)) return "model_error"
	return "agent_error"
}

/** The row's `error` for a reason: its code first, so it can be read back. */
export const reviewFailureError = (reason: PrReviewFailureReason): string =>
	`${reason}: ${PR_REVIEW_FAILURE_COPY[reason]} Retry with @maple review.`
