import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { McpToolsRateLimit, type RateLimiter } from "@/platform/bindings"
import { testEnv } from "@/services/integrations/vcs/__tests__/harness"
import { makeApiV2RateLimitKey } from "./ApiV2RateLimiter"
import { McpToolRateLimiter } from "./McpToolRateLimiter"

describe("McpToolRateLimiter", () => {
	it.effect("counts against its own binding under the deployment", () => {
		const keys: string[] = []
		const limiter: RateLimiter = {
			limit: (key) =>
				Effect.sync(() => {
					keys.push(key)
					return { success: false }
				}),
		}

		return Effect.gen(function* () {
			const limiter = yield* McpToolRateLimiter
			expect(yield* limiter.check("key:abc")).toBe("limited")
			expect(keys).toEqual([makeApiV2RateLimitKey("stg", "key:abc")])
		}).pipe(
			Effect.provide(
				McpToolRateLimiter.layer.pipe(
					Layer.provide(Layer.succeed(McpToolsRateLimit, limiter)),
					Layer.provide(testEnv({ MAPLE_ENVIRONMENT: "stg" })),
				),
			),
		)
	})
})
