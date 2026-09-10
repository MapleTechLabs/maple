/**
 * Every ceiling a run answers to, in one place.
 *
 * Collected deliberately. These numbers only make sense against each other — the turn cap
 * multiplies against tool concurrency and against the sub-agent fan-out, and the product has to
 * stay under `ChatSession`'s `TURN_STALE_MS` watchdog or the Durable Object will declare a
 * *still-running* turn abandoned and write a terminal event underneath it.
 *
 * `agentPolicyFor` in `./agents.ts` is the only reader: these are the inputs to an `AgentPolicy`,
 * and the engine enforces them.
 */

/**
 * Hard cap on *tool-calling* assistant turns per submission.
 *
 * A turn that hits it gets one further, tool-less step so the model can answer from what it found,
 * rather than stopping dead on a wall of tool rows with no words.
 */
export const MAX_STEPS = 10

/** Fan-out cap for tool calls issued in the same assistant turn. */
export const TOOL_CONCURRENCY = 4

/**
 * Assistant turns a sub-agent gets.
 *
 * Two-thirds of the parent's budget: enough to search and summarize, not enough to wander. A
 * sub-agent that runs out simply reports what it found, which is a fine answer.
 */
export const SUBAGENT_MAX_STEPS = 6

/**
 * Consecutive tool-call *failures* that mean the model is stuck rather than working.
 *
 * Three, because two is a plausible retry — a model reissuing a call after a transient tool failure
 * is behaving correctly — and the third consecutive failure says nothing in the results is being
 * read. It becomes the policy's `repeatedFailureLimit`, and a success resets the count.
 *
 * Note what it does *not* bound: identical calls that keep succeeding. That guard lives with the
 * tool handlers, as `IDENTICAL_CALL_LIMIT` in `@/mcp/tools/llm-tools`, because refusing there is a
 * declared failure the model can read — and three of those trip this limit, which stops the run.
 */
export const REPEATED_TOOL_CALLS = 3

/**
 * Wall clock one run may take.
 *
 * Held well under `ChatSession`'s `TURN_STALE_MS` (15 minutes) so the deadline that stops a turn is
 * the turn's own, not the Durable Object's watchdog declaring a still-running turn abandoned and
 * writing a terminal event underneath it.
 */
export const TURN_MAX_DURATION = "10 minutes"
