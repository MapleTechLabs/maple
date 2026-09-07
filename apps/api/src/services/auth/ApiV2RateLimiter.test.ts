import { describe, expect, it } from "@effect/vitest"
import { ApiKeyId } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import { ApiV2RateLimit, RateLimitBindingError, type RateLimiter } from "@/platform/bindings"
import { testEnv } from "@/services/integrations/vcs/__tests__/harness"
import { ApiV2RateLimiter, makeApiV2RateLimitKey } from "./ApiV2RateLimiter"

const KEY_A = Schema.decodeUnknownSync(ApiKeyId)("00000000-0000-4000-8000-000000000001")
const KEY_B = Schema.decodeUnknownSync(ApiKeyId)("00000000-0000-4000-8000-000000000002")

/** The limiter over a fake binding port (or none at all), keyed under the given deployment. */
const limiterLayer = (limiter: RateLimiter | undefined, environment = "stg") =>
	ApiV2RateLimiter.layer.pipe(
		Layer.provide(limiter === undefined ? Layer.empty : Layer.succeed(ApiV2RateLimit, limiter)),
		Layer.provide(testEnv({ MAPLE_ENVIRONMENT: environment })),
	)

const allowing =
	(observed: string[]) =>
	(key: string): ReturnType<RateLimiter["limit"]> =>
		Effect.sync(() => {
			observed.push(key)
			return { success: true }
		})

describe("ApiV2RateLimiter", () => {
	it.effect("uses only the deployment and internal API-key ID as the counter key", () => {
		const keys: string[] = []
		return Effect.gen(function* () {
			const limiter = yield* ApiV2RateLimiter
			expect(yield* limiter.check(KEY_A)).toBe("allowed")
			expect(yield* limiter.check(KEY_B)).toBe("allowed")
			expect(keys).toEqual([makeApiV2RateLimitKey("stg", KEY_A), makeApiV2RateLimitKey("stg", KEY_B)])
			expect(keys.join(" ")).not.toContain("maple_ak_")
		}).pipe(Effect.provide(limiterLayer({ limit: allowing(keys) })))
	})

	it.effect("isolates the same key across deployments", () => {
		const observed: string[] = []
		const run = (environment: string) =>
			Effect.gen(function* () {
				const limiter = yield* ApiV2RateLimiter
				return yield* limiter.check(KEY_A)
			}).pipe(Effect.provide(limiterLayer({ limit: allowing(observed) }, environment)))

		return Effect.gen(function* () {
			expect(yield* run("production")).toBe("allowed")
			expect(yield* run("stg")).toBe("allowed")
			expect(observed).toEqual([
				makeApiV2RateLimitKey("production", KEY_A),
				makeApiV2RateLimitKey("stg", KEY_A),
			])
		})
	})

	it.effect("returns limited when Cloudflare denies the key", () =>
		Effect.gen(function* () {
			const limiter = yield* ApiV2RateLimiter
			expect(yield* limiter.check(KEY_A)).toBe("limited")
		}).pipe(Effect.provide(limiterLayer({ limit: () => Effect.succeed({ success: false }) }))),
	)

	it.effect("fails open when the binding is unavailable", () =>
		Effect.gen(function* () {
			const limiter = yield* ApiV2RateLimiter
			expect(yield* limiter.check(KEY_A)).toBe("failed_open")
		}).pipe(Effect.provide(limiterLayer(undefined))),
	)

	it.effect("fails open when the Cloudflare binding throws", () =>
		Effect.gen(function* () {
			const limiter = yield* ApiV2RateLimiter
			expect(yield* limiter.check(KEY_A)).toBe("failed_open")
		}).pipe(
			Effect.provide(
				limiterLayer({
					limit: () =>
						Effect.fail(
							new RateLimitBindingError({
								message: "binding unavailable",
								cause: new Error("binding unavailable"),
							}),
						),
				}),
			),
		),
	)
})
