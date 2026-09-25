/**
 * The words a failed review's pull request is shown come from the run's typed cause, never its text.
 */
import { AgentPolicyError, ContextBudgetError, ModelProtocolError } from "effect-agent/agent-error"
import { prReviewFailureReason } from "@maple/domain/http"
import { Cause } from "effect"
import { assert, describe, it } from "vitest"
import { reviewFailureError, reviewFailureReason } from "./review-failure"

const policy = (limit: AgentPolicyError["limit"]) =>
	Cause.fail(AgentPolicyError.make({ limit, message: `${limit} exceeded` }))

describe("reviewFailureReason", () => {
	it("names the limit that stopped the run", () => {
		assert.equal(reviewFailureReason(policy("duration")), "time_limit")
		assert.equal(reviewFailureReason(policy("tool-calls")), "step_limit")
		assert.equal(reviewFailureReason(policy("tokens")), "step_limit")
		assert.equal(reviewFailureReason(policy("repeated-failures")), "stuck")
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
		assert.equal(reviewFailureReason(overflow), "context_limit")
		assert.equal(reviewFailureReason(Cause.die("boom")), "agent_error")
	})
})

describe("reviewFailureReason over a combined cause", () => {
	it("reports the typed limit even when a generic failure comes first", () => {
		const combined = Cause.combine(Cause.die("boom"), policy("duration"))
		assert.equal(reviewFailureReason(combined), "time_limit")
	})

	it("reads the engine's event ceiling as a step limit", () => {
		const events = Cause.fail(
			ModelProtocolError.make({ message: "Run exceeded the 65536-event buffer limit" }),
		)
		assert.equal(reviewFailureReason(events), "step_limit")
	})
})

describe("reviewFailureError", () => {
	it("reads back as its reason", () => {
		assert.equal(prReviewFailureReason(reviewFailureError("time_limit")), "time_limit")
	})
})
