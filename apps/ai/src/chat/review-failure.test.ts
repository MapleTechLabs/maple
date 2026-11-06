/**
 * The words a failed review's pull request is shown come from the run's typed cause, never its text.
 */
import { AgentPolicyError, ContextBudgetError, ModelProtocolError } from "@yielded/agent/agent-error"
import { prReviewFailureReason } from "@maple/domain/http"
import { Cause } from "effect"
import { AiError, AuthenticationError, QuotaExhaustedError, RateLimitError } from "effect/ai/AiError"
import { assert, describe, it } from "vitest"
import { reviewFailureError, reviewFailureReason } from "./review-failure"

const MAPLE_KEY = { ownKey: false }
const ORG_KEY = { ownKey: true }

const provider = (reason: AiError["reason"]) =>
	Cause.fail(new AiError({ module: "OpenRouterClient", method: "createChatCompletionStream", reason }))
const rejectedKey = provider(new AuthenticationError({ kind: "InvalidKey" }))
const noCredits = provider(new QuotaExhaustedError({}))

const policy = (limit: AgentPolicyError["limit"]) =>
	Cause.fail(AgentPolicyError.make({ limit, message: `${limit} exceeded` }))

describe("reviewFailureReason", () => {
	it("names the limit that stopped the run", () => {
		assert.equal(reviewFailureReason(policy("duration"), MAPLE_KEY), "time_limit")
		assert.equal(reviewFailureReason(policy("tool-calls"), MAPLE_KEY), "step_limit")
		assert.equal(reviewFailureReason(policy("tokens"), MAPLE_KEY), "step_limit")
		assert.equal(reviewFailureReason(policy("repeated-failures"), MAPLE_KEY), "stuck")
	})

	it("tells a context overflow from anything else", () => {
		const overflow = Cause.fail(
			ContextBudgetError.make({
				message: "too big",
				estimatedTokens: 200_000,
				targetTokens: 128_000,
				completionReserveTokens: 0,
			}),
		)
		assert.equal(reviewFailureReason(overflow, MAPLE_KEY), "context_limit")
		assert.equal(reviewFailureReason(Cause.die("boom"), MAPLE_KEY), "agent_error")
	})
})

describe("reviewFailureReason over a combined cause", () => {
	it("reports the typed limit even when a generic failure comes first", () => {
		const combined = Cause.combine(Cause.die("boom"), policy("duration"))
		assert.equal(reviewFailureReason(combined, MAPLE_KEY), "time_limit")
	})

	it("reads the engine's event ceiling as a step limit", () => {
		const events = Cause.fail(
			ModelProtocolError.make({ message: "Run exceeded the 65536-event buffer limit" }),
		)
		assert.equal(reviewFailureReason(events, MAPLE_KEY), "step_limit")
	})
})

describe("reviewFailureReason over a provider failure", () => {
	it("puts a rejected key on whoever owns it", () => {
		assert.equal(reviewFailureReason(rejectedKey, MAPLE_KEY), "service_misconfigured")
		assert.equal(reviewFailureReason(rejectedKey, ORG_KEY), "org_key_rejected")
	})

	it("puts an exhausted quota on whoever owns the key", () => {
		assert.equal(reviewFailureReason(noCredits, MAPLE_KEY), "service_misconfigured")
		assert.equal(reviewFailureReason(noCredits, ORG_KEY), "org_key_no_credits")
	})

	it("reads a rate limit as a passing outage", () => {
		assert.equal(reviewFailureReason(provider(new RateLimitError({})), ORG_KEY), "provider_unavailable")
	})

	it("still reports a typed limit over a provider failure", () => {
		assert.equal(
			reviewFailureReason(Cause.combine(rejectedKey, policy("duration")), MAPLE_KEY),
			"time_limit",
		)
	})
})

describe("reviewFailureError", () => {
	it("reads back as its reason", () => {
		assert.equal(prReviewFailureReason(reviewFailureError("time_limit")), "time_limit")
	})
})
