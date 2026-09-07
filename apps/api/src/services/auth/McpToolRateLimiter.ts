import { Context, Effect, Layer } from "effect"
import { McpToolsRateLimit } from "@/platform/bindings"
import { makeRateLimitCheck, type RateLimiterApi } from "./ApiV2RateLimiter"

export const MCP_TOOLS_RATE_LIMIT_REQUESTS = 120
export const MCP_TOOLS_RATE_LIMIT_PERIOD_SECONDS = 10

/**
 * Per-credential limiter for the authenticated MCP surface (`POST /mcp`).
 *
 * A dedicated binding rather than the v2 limiter's so the budget can move
 * independently — an agent driving MCP bursts tool calls far harder than a
 * client hand-rolling `/v2` requests. 120/10s allows twice the v2 throughput
 * while keeping the window short, so a runaway loop is cut off in seconds
 * rather than after a minute of fan-out.
 * Keys arrive pre-scoped by the resolver (`key:<keyId>` / `user:<userId>`) and
 * share the stage partition with the other limiters.
 */
export class McpToolRateLimiter extends Context.Service<McpToolRateLimiter, RateLimiterApi>()(
	"@maple/api/services/McpToolRateLimiter",
	{
		make: Effect.gen(function* () {
			const limiter = yield* Effect.serviceOption(McpToolsRateLimit)
			const check = makeRateLimitCheck(limiter, {
				spanName: "McpToolRateLimiter.check",
				failOpenMessage: "MCP tool rate limiter unavailable; allowing request",
			})
			return { check } satisfies RateLimiterApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
