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
} from "@yielded/agent/agent-error"
import { PR_REVIEW_FAILURE_COPY, type PrReviewFailureReason } from "@maple/domain/http"
import { Cause } from "effect"
import { isAiError, type AiError } from "effect/ai/AiError"

/** Whose OpenRouter key the run used: a rejected org key is theirs to fix, a rejected Maple key is ours. */
export interface ReviewFailureContext {
	readonly ownKey: boolean
}

/** What a provider failure means for the pull request. Only the reason's tag is read, never its text. */
const providerReason = (error: AiError, context: ReviewFailureContext): PrReviewFailureReason => {
	switch (error.reason._tag) {
		case "AuthenticationError":
			return context.ownKey ? "org_key_rejected" : "service_misconfigured"
		case "QuotaExhaustedError":
			return context.ownKey ? "org_key_no_credits" : "service_misconfigured"
		case "RateLimitError":
		case "InternalProviderError":
		case "NetworkError":
			return "provider_unavailable"
		default:
			return "model_error"
	}
}

/** Provider failures, which rank below any typed limit the same cause carries. */
const PROVIDER_REASONS: ReadonlySet<PrReviewFailureReason> = new Set([
	"model_error",
	"provider_unavailable",
	"service_misconfigured",
	"org_key_rejected",
	"org_key_no_credits",
])

/** The reason one error names, or `undefined` for one that says nothing specific. */
const reasonOf = (error: unknown, context: ReviewFailureContext): PrReviewFailureReason | undefined => {
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
	if (isAiError(error)) return providerReason(error, context)
	return undefined
}

/**
 * The reason a failed run's cause names. Every failure is read, not only the first, so a typed
 * limit is reported even when a generic failure sits ahead of it; otherwise it is an `agent_error`.
 */
export const reviewFailureReason = (
	cause: Cause.Cause<unknown>,
	context: ReviewFailureContext,
): PrReviewFailureReason => {
	const errors = cause.reasons.flatMap((reason) =>
		Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : [],
	)
	const reasons = errors.map((error) => reasonOf(error, context))
	return (
		reasons.find((reason) => reason !== undefined && !PROVIDER_REASONS.has(reason)) ??
		reasons.find((reason) => reason !== undefined) ??
		"agent_error"
	)
}

/**
 * The row's `error` for a reason: its code first, so it can be read back. No retry hint: this
 * worker does not know the install's App login, and the comment and check already carry one.
 */
export const reviewFailureError = (reason: PrReviewFailureReason): string =>
	`${reason}: ${PR_REVIEW_FAILURE_COPY[reason]}`
