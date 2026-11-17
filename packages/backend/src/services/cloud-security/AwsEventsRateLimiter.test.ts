import { describe, expect, it } from "@effect/vitest"
import { AwsConnectionId } from "@maple/primitives"
import { Effect, Layer, Schema } from "effect"
import { AwsEventsRateLimit, type RateLimiter } from "@maple/backend/platform/bindings"
import { testEnv } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { AwsEventsRateLimiter } from "./AwsEventsRateLimiter"

const connectionId = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")

describe("AwsEventsRateLimiter", () => {
	it.effect("counts each connection in its own bucket under the deployment", () => {
		const keys: string[] = []
		const binding: RateLimiter = {
			limit: (key) =>
				Effect.sync(() => {
					keys.push(key)
					return { success: false }
				}),
		}
		return Effect.gen(function* () {
			const limiter = yield* AwsEventsRateLimiter
			expect(yield* limiter.check(connectionId)).toBe("limited")
			expect(keys).toEqual([`stg:awsev:${connectionId}`])
		}).pipe(
			Effect.provide(
				AwsEventsRateLimiter.layer.pipe(
					Layer.provide(Layer.succeed(AwsEventsRateLimit, binding)),
					Layer.provide(testEnv({ MAPLE_ENVIRONMENT: "stg" })),
				),
			),
		)
	})

	it.effect("lets deliveries through when the deployment has no limiter", () =>
		Effect.gen(function* () {
			const limiter = yield* AwsEventsRateLimiter
			expect(yield* limiter.check(connectionId)).toBe("failed_open")
		}).pipe(Effect.provide(AwsEventsRateLimiter.layer.pipe(Layer.provide(testEnv({}))))),
	)
})
