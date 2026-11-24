import { AgentPolicyError, ContextBudgetError, ModelProtocolError } from "@yielded/agent/agent-error"
import { AiError, InternalProviderError, RateLimitError } from "effect/ai/AiError"
import { describe, expect, it } from "vitest"
import { isAnticipatedChatFailure } from "./expected-failures"

const provider = (reason: AiError["reason"]) =>
	new AiError({ module: "OpenRouterClient", method: "createChatCompletionStream", reason })

describe("isAnticipatedChatFailure", () => {
	it.each([
		[
			"a duration limit",
			AgentPolicyError.make({ limit: "duration", message: "Agent exceeded its 6m duration limit" }),
		],
		["a repeated-failure limit", AgentPolicyError.make({ limit: "repeated-failures", message: "stuck" })],
		[
			"a tool call streamed before its parameters",
			ModelProtocolError.make({
				message: "Model response declared Tool Call c-1 before its parameters completed",
			}),
		],
		["a provider rate limit", provider(new RateLimitError({}))],
	])("exports %s as Ok", (_, error) => {
		expect(isAnticipatedChatFailure(error)).toBe(true)
	})

	it.each([
		["a provider outage before streaming", provider(new InternalProviderError({ description: "502" }))],
		[
			"a context budget failure",
			ContextBudgetError.make({
				message: "too big",
				estimatedTokens: 200_000,
				targetTokens: 128_000,
				completionReserveTokens: 0,
			}),
		],
		["a defect", { _tag: "UnknownException", message: "boom" }],
	])("keeps %s an Error", (_, error) => {
		expect(isAnticipatedChatFailure(error)).toBe(false)
	})
})
