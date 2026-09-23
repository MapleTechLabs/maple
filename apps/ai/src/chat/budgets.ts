/**
 * Every ceiling a run answers to, in one place.
 *
 * Collected deliberately. These numbers only make sense against each other, and against the two
 * rails outside this file: the product has to stay under `ChatSession`'s `TURN_STALE_MS` watchdog
 * or the Durable Object will declare a *still-running* turn abandoned and write a terminal event
 * underneath it, and `contextTokenLimit` is a hard failure rather than a nudge (see
 * {@link liveContextLimit}).
 *
 * `agentPolicyFor` in `./agents.ts` is the only reader: these are the inputs to an `AgentPolicy`,
 * and the engine enforces them.
 *
 * The numbers below are set from prod, internal org, 2026-09-17..19: per turn p50 343k input
 * tokens and p95 1.16M (max 2.06M); p50 21 tool calls and max 54; the largest single call's input
 * p95 98k and max 140k.
 */

import type * as Duration from "effect/Duration"

/** Fan-out cap for tool calls issued in the same assistant turn. */
export const TOOL_CONCURRENCY = 4

/**
 * Consecutive tool-call *failures* that mean the model is stuck rather than working.
 *
 * Five, because tool errors are returned to the model: rewriting a rejected query two or three times
 * is the model working, and one batch can fail `TOOL_CONCURRENCY` calls at once. Five in a row says
 * nothing in the results is being read. It becomes the policy's `repeatedFailureLimit`, and a
 * success resets the count.
 *
 * Note what it does *not* bound: identical calls that keep succeeding. That guard lives with the
 * tool handlers, as `IDENTICAL_CALL_LIMIT` in `@/mcp/tools/llm-tools`, because refusing there is a
 * returned failure the model can read, and enough of those trip this limit, which stops the run.
 */
export const REPEATED_TOOL_CALLS = 5

/**
 * What one kind of turn may spend.
 *
 * Per agent, because the kinds of turn are not the same work: an unattended pass needs rails that
 * force it to conclude, while an attended chat turn has a person who can stop it.
 */
export interface AgentBudget {
	/** Hard cap on tool calls, and on assistant turns, so a turn can never be stopped for thinking more often than it called a tool. */
	readonly maxToolCalls: number
	/** Wall clock. Held under `ChatSession`'s `TURN_STALE_MS` so the deadline that stops a turn is the turn's own. */
	readonly maxDuration: Duration.Input
	/**
	 * Total tokens, input plus output, the run may consume.
	 *
	 * Unset until 2026-09-20, which meant nothing bounded a run's spend at all: `maxToolCalls` was
	 * never reached (max 54 of 100) and `maxDuration` stopped only the truly stuck, so the long tail
	 * ran to 2.06M tokens. Crossing it flips the run to its final answer rather than failing it,
	 * which is the behaviour worth having: a run that has burned this much is not going to improve,
	 * and what we want from it is the diagnosis it already has evidence for.
	 */
	readonly tokenBudget: number
	/**
	 * Tokens withheld from research calls so one final delivery call stays admissible.
	 *
	 * The engine stops offering tools once the next call would eat into this, then admits the final
	 * call regardless of the budget. Sized as one real call rather than the engine's 4,096 default,
	 * which is smaller than any prompt this agent sends and would let research run to the last token.
	 */
	readonly completionReserveTokens: number
}

/**
 * An autonomous investigation: a long evidence-gathering pass that must end on `submit_diagnosis`.
 *
 * `maxToolCalls` stays a runaway guard rather than a budget the model should pace against, which is
 * why it sits far above the 54 calls the worst observed run made. `tokenBudget` sits just above the
 * p95 turn, so roughly one run in twenty is asked to conclude and the rest are untouched.
 */
export const INVESTIGATION_BUDGET: AgentBudget = {
	maxToolCalls: 100,
	maxDuration: "10 minutes",
	tokenBudget: 1_200_000,
	completionReserveTokens: 64_000,
}

/**
 * An unattended pull request review: read every hunk that adds code, check the warehouse where the
 * diff names a service or an attribute, file one report through `submit_review`.
 *
 * Smaller than an investigation because the diff bounds the work: the reviewer reads files it was
 * handed rather than searching telemetry for a cause. Sized before any review has run in prod, so
 * these are ceilings to tune from the internal org's first reviews, not measurements.
 */
export const PR_REVIEW_BUDGET: AgentBudget = {
	maxToolCalls: 60,
	maxDuration: "8 minutes",
	tokenBudget: 800_000,
	completionReserveTokens: 48_000,
}

/**
 * An attended chat turn, in the app or through a chat connector.
 *
 * Generous on purpose: a real investigation in chat hit the old 40-call, 600k-token rail around
 * its 23rd tool call. Someone is watching and can stop it, so the step cap binds rather than
 * tokens: `tokenBudget` clears `maxToolCalls` calls at a full `MAX_LIVE_CONTEXT_TOKENS` prompt.
 */
export const CHAT_BUDGET: AgentBudget = {
	maxToolCalls: 120,
	maxDuration: "15 minutes",
	tokenBudget: 16_000_000,
	completionReserveTokens: 32_000,
}

/**
 * The largest prompt one model call may carry before the engine compacts.
 *
 * This used to be the model's entire context window, which made compaction unreachable: a single
 * call would have had to reach a million tokens on `glm-5.3-flash` before anything pruned, while the
 * worst call actually observed was 140k. The `CompactionPolicy` underneath it had therefore never
 * run, and `agents.ts` claimed compaction was "the engine's job" when it was nobody's.
 *
 * Two bounds, because the failure modes differ by model. The fraction keeps a small-window model
 * from compacting into a prompt that leaves no room for its own output. The absolute cap is what
 * bites on a million-token model, and is set above the observed p95 of 98k so compaction stays
 * exceptional.
 *
 * Do not set this near the floor. It is a hard rail, not a nudge: when compaction cannot fit the
 * next prompt underneath it the engine raises `ContextBudgetError` and the run dies. The floor is
 * the system prompt plus the tool schemas plus `CompactionPolicy.keepRecentTokens` (20k), so the
 * headroom above it is what keeps a long run alive.
 */
export const MAX_LIVE_CONTEXT_TOKENS = 128_000
const LIVE_CONTEXT_FRACTION = 0.6

export const liveContextLimit = (modelContextTokens: number): number =>
	Math.max(1, Math.min(Math.floor(modelContextTokens * LIVE_CONTEXT_FRACTION), MAX_LIVE_CONTEXT_TOKENS))
