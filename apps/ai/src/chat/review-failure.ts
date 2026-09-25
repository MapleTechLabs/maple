/**
 * Why a review pass stopped without a report, in the fixed vocabulary the pull request is shown.
 *
 * The raw cause stays in logs and spans; only the reason reaches GitHub, as the prefix of the error
 * the row stores (`time_limit: ...`), which `PrReviewService` turns back into one sentence.
 */
import {
	AgentPolicyError,
	ContextBudgetError,
	ContextOverflowError,
	ModelProtocolError,
} from "effect-agent/agent-error"
import { PR_REVIEW_FAILURE_COPY, type PrReviewFailureReason } from "@maple/domain/http"
import { Cause } from "effect"
import { isAiError } from "effect/unstable/ai/AiError"

/** The reason one error names, or `undefined` for one that says nothing specific. */
const reasonOf = (error: unknown): PrReviewFailureReason | undefined => {
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
	// The engine's run-event and response-part ceilings: the run outgrew its room, like a step limit.
	if (error instanceof ModelProtocolError && /exceeded the \d+-(event|part)/.test(error.message))
		return "step_limit"
	if (isAiError(error)) return "model_error"
	return undefined
}

/**
 * The reason a failed run's cause names. Every failure is read, not only the first, so a typed
 * limit is reported even when a generic failure sits ahead of it; otherwise it is an `agent_error`.
 */
export const reviewFailureReason = (cause: Cause.Cause<unknown>): PrReviewFailureReason => {
	const errors = cause.reasons.flatMap((reason) =>
		Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : [],
	)
	const reasons = errors.map(reasonOf)
	return (
		reasons.find((reason) => reason !== undefined && reason !== "model_error") ??
		reasons.find((reason) => reason !== undefined) ??
		"agent_error"
	)
}

/** The row's `error` for a reason: its code first, so it can be read back. */
export const reviewFailureError = (reason: PrReviewFailureReason): string =>
	`${reason}: ${PR_REVIEW_FAILURE_COPY[reason]} Retry with @maple review.`
