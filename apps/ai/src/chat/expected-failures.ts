/**
 * Agent-run failures that are expected outcomes, not bugs in Maple, so their spans export `Ok`.
 *
 * Each one is settled by the turn rather than ending it: a policy limit is the rail doing its job
 * (the pass closes out, a child's limit becomes its parent's tool result), a protocol break is a
 * malformed response from the model or its provider (resumed, then closed out), and a rate limit is
 * the provider's, retried by the engine. The turn's outcome still records each one by name.
 */
import { isAiError } from "effect/ai/AiError"
import { Predicate } from "effect"
import { isAnticipatedMcpFailure } from "../mcp/expected-failures"

// BOUNDARY: the tracer hands over a cause's raw failure values.
const AGENT_OUTCOME_TAGS: ReadonlySet<unknown> = new Set(["AgentPolicyError", "ModelProtocolError"])

/** An engine rail, a malformed model response, or a provider rate limit. */
export const isAnticipatedAgentFailure = (error: unknown): boolean =>
	(Predicate.hasProperty(error, "_tag") && AGENT_OUTCOME_TAGS.has(error._tag)) ||
	(isAiError(error) && error.reason._tag === "RateLimitError")

/** What a `ChatSession` invocation's tracer exports as `Ok`: the MCP set plus the agent outcomes. */
export const isAnticipatedChatFailure = (error: unknown): boolean =>
	isAnticipatedMcpFailure(error) || isAnticipatedAgentFailure(error)
