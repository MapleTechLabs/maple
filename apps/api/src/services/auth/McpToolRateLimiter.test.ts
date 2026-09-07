import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ApiV2RateLimit, McpToolsRateLimit, type RateLimiter } from "@/platform/bindings"
import { makeApiV2RateLimitKey } from "./ApiV2RateLimiter"
import { McpToolRateLimiter } from "./McpToolRateLimiter"

describe("McpToolRateLimiter", () => {
	it.effect("counts against its own binding under the stage partition", () => {
		const keys: string[] = []
		const limiter: RateLimiter = {
			partition: "stg",
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
				McpToolRateLimiter.layer.pipe(Layer.provide(Layer.succeed(McpToolsRateLimit, limiter))),
			),
		)
	})

	it.effect("fails open when only the v2 binding is present", () =>
		Effect.gen(function* () {
			const limiter = yield* McpToolRateLimiter
			expect(yield* limiter.check("key:abc")).toBe("failed_open")
		}).pipe(
			Effect.provide(
				McpToolRateLimiter.layer.pipe(
					Layer.provide(
						Layer.succeed(ApiV2RateLimit, {
							partition: "prd",
							limit: () => Effect.succeed({ success: true }),
						}),
					),
				),
			),
		),
	)
})
