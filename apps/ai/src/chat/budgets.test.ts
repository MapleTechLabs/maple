/**
 * The ceilings, pinned against the traffic they were set from.
 *
 * Every number here was chosen from prod (internal org, 2026-09-17..19) and a number chosen from
 * traffic drifts silently when the traffic changes. These tests say what each bound was meant to
 * clear, so raising the model's window or swapping the model cannot quietly disable one again.
 */
import { describe, expect, it } from "vitest"
import { AgentPolicy } from "@effect-agent/core/AgentPolicy"
import * as Duration from "effect/Duration"
import { AGENTS, agentPolicyFor } from "./agents"
import {
	CHAT_BUDGET,
	INVESTIGATION_BUDGET,
	liveContextLimit,
	MAX_LIVE_CONTEXT_TOKENS,
	PR_REPLY_BUDGET,
	PR_REVIEW_BUDGET,
	type AgentBudget,
} from "./budgets"
import { TURN_STALE_MS } from "./ChatSession"

/** The window `z-ai/glm-5.3-flash:nitro` reports, which is what made this a bug. */
const GLM_CONTEXT = 1_000_000
/** The largest single model-call prompt observed over the window. */
const WORST_OBSERVED_CALL = 140_464
/** p95 of the same. */
const P95_OBSERVED_CALL = 98_062

describe("liveContextLimit", () => {
	/**
	 * The regression this exists for: `contextTokenLimit` was the model's whole window, so a call
	 * would have had to reach a million tokens before compaction ran, and it never did.
	 */
	it("is far below the model's own window on a long-context model", () => {
		expect(liveContextLimit(GLM_CONTEXT)).toBeLessThan(GLM_CONTEXT / 4)
	})

	it("sits above the observed p95 call, so compaction stays exceptional", () => {
		expect(liveContextLimit(GLM_CONTEXT)).toBeGreaterThan(P95_OBSERVED_CALL)
	})

	it("sits below the worst observed call, so the runaway tail does compact", () => {
		expect(liveContextLimit(GLM_CONTEXT)).toBeLessThan(WORST_OBSERVED_CALL)
	})

	/** It is a hard rail: a prompt that cannot be compacted under it fails the run. */
	it("leaves a small-window model room for its own output", () => {
		expect(liveContextLimit(128_000)).toBeLessThanOrEqual(128_000 * 0.75)
	})

	it("never exceeds the absolute cap, whatever the model claims", () => {
		expect(liveContextLimit(10_000_000)).toBe(MAX_LIVE_CONTEXT_TOKENS)
	})
})

describe("agent budgets", () => {
	/**
	 * A chat turn hit a 600k rail at 23 tool calls, and a review hit 800k at 18: tokens count every
	 * re-sent prompt, so the step cap or the wall clock must bind first on every agent.
	 */
	it("lets every turn reach its step cap at a full live context", () => {
		for (const budget of [CHAT_BUDGET, INVESTIGATION_BUDGET, PR_REVIEW_BUDGET, PR_REPLY_BUDGET]) {
			expect(budget.tokenBudget).toBeGreaterThanOrEqual(budget.maxToolCalls * MAX_LIVE_CONTEXT_TOKENS)
		}
	})

	/** Past `TURN_STALE_MS` the session abandons the turn, so every turn's own deadline comes first. */
	it("stops every turn before the stale-claim watchdog would", () => {
		const ms = (budget: AgentBudget) => Duration.toMillis(budget.maxDuration)
		const margin = 5 * 60 * 1000
		expect(ms(CHAT_BUDGET) + margin).toBeLessThanOrEqual(TURN_STALE_MS)
		// An unattended pass that ends without its report gets a close-out run under the same budget.
		for (const budget of [INVESTIGATION_BUDGET, PR_REVIEW_BUDGET, PR_REPLY_BUDGET]) {
			expect(2 * ms(budget) + margin).toBeLessThanOrEqual(TURN_STALE_MS)
		}
	})

	/** p95 turn was 1.16M tokens: the budget is meant to catch the tail, not ordinary work. */
	it("leaves the median investigation untouched", () => {
		expect(INVESTIGATION_BUDGET.tokenBudget).toBeGreaterThan(343_128 * 2)
	})

	/** The engine admits the final call regardless, but research must stop with real room left. */
	it("reserves more than one observed prompt for the closing call", () => {
		expect(INVESTIGATION_BUDGET.completionReserveTokens).toBeGreaterThan(54_627)
	})

	it("reserves less than the budget it is carved from", () => {
		for (const budget of [CHAT_BUDGET, INVESTIGATION_BUDGET]) {
			expect(budget.completionReserveTokens).toBeLessThan(budget.tokenBudget)
		}
	})
})

describe("agentPolicyFor", () => {
	it("builds a valid policy for every agent", () => {
		for (const agent of Object.values(AGENTS)) {
			expect(agentPolicyFor(agent, GLM_CONTEXT)).toBeInstanceOf(AgentPolicy)
		}
	})

	/** It ignored its agent argument until 2026-09-20, so every surface got the same rail. */
	it("reads the agent's own budget rather than one shared number", () => {
		const investigate = agentPolicyFor(AGENTS.investigate!, GLM_CONTEXT)
		const chat = agentPolicyFor(AGENTS.default!, GLM_CONTEXT)
		expect(investigate.maxToolCalls).not.toBe(chat.maxToolCalls)
		expect(investigate.tokenBudget).not.toBe(chat.tokenBudget)
	})

	it("derives the context limit instead of passing the window through", () => {
		expect(agentPolicyFor(AGENTS.investigate!, GLM_CONTEXT).contextTokenLimit).toBe(
			liveContextLimit(GLM_CONTEXT),
		)
	})

	/** Crossing a budget must hand the run its closing call, never fail it outright. */
	it("resolves an exhausted budget into a final answer", () => {
		expect(agentPolicyFor(AGENTS.investigate!, GLM_CONTEXT).onExhaustion).toBe("final-answer")
	})
})
