import { Context, Effect, Layer } from "effect"
import { McpToolsRateLimit } from "@/platform/bindings"
import { Env } from "@/platform/Env"
import { makeRateLimitCheck, type RateLimiterApi } from "./ApiV2RateLimiter"

export const MCP_TOOLS_RATE_LIMIT_REQUESTS = 120
export const MCP_TOOLS_RATE_LIMIT_PERIOD_SECONDS = 10

/**
 * Per-credential limiter for the authenticated MCP surface (`POST /mcp`), on
 * its own binding so its budget moves independently of the v2 API's. Keys
 * arrive pre-scoped by the resolver (`key:<keyId>` / `user:<userId>`).
 */
export class McpToolRateLimiter extends Context.Service<McpToolRateLimiter, RateLimiterApi>()(
	"@maple/api/services/McpToolRateLimiter",
	{
		make: Effect.gen(function* () {
			const limiter = yield* Effect.serviceOption(McpToolsRateLimit)
			const env = yield* Env
			const check = makeRateLimitCheck(limiter, env.MAPLE_ENVIRONMENT, {
				spanName: "McpToolRateLimiter.check",
				failOpenMessage: "MCP tool rate limiter unavailable; allowing request",
			})
			return { check } satisfies RateLimiterApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
