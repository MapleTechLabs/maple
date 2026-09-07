import { describe, expect, it } from "@effect/vitest"
import { ApiKeyId } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import { ApiV2RateLimit, RateLimitBindingError, type RateLimiter } from "@/platform/bindings"
import { ApiV2RateLimiter, makeApiV2RateLimitKey } from "./ApiV2RateLimiter"

const KEY_A = Schema.decodeUnknownSync(ApiKeyId)("00000000-0000-4000-8000-000000000001")
const KEY_B = Schema.decodeUnknownSync(ApiKeyId)("00000000-0000-4000-8000-000000000002")

/** The limiter over a fake binding port, or over none at all. */
const limiterLayer = (limiter: RateLimiter | undefined) =>
	ApiV2RateLimiter.layer.pipe(
		Layer.provide(limiter === undefined ? Layer.empty : Layer.succeed(ApiV2RateLimit, limiter)),
	)

const allowing =
	(observed: string[]) =>
	(key: string): ReturnType<RateLimiter["limit"]> =>
		Effect.sync(() => {
			observed.push(key)
			return { success: true }
		})

describe("ApiV2RateLimiter", () => {
	it.effect("uses only the stage partition and internal API-key ID as the counter key", () => {
		const keys: string[] = []
		return Effect.gen(function* () {
			const limiter = yield* ApiV2RateLimiter
			expect(yield* limiter.check(KEY_A)).toBe("allowed")
			expect(yield* limiter.check(KEY_B)).toBe("allowed")
			expect(keys).toEqual([makeApiV2RateLimitKey("stg", KEY_A), makeApiV2RateLimitKey("stg", KEY_B)])
			expect(keys.join(" ")).not.toContain("maple_ak_")
		}).pipe(Effect.provide(limiterLayer({ partition: "stg", limit: allowing(keys) })))
	})

	it.effect("isolates the same key across deployment stages", () => {
		const observed: string[] = []
		const run = (partition: string) =>
			Effect.gen(function* () {
				const limiter = yield* ApiV2RateLimiter
				return yield* limiter.check(KEY_A)
			}).pipe(Effect.provide(limiterLayer({ partition, limit: allowing(observed) })))

		return Effect.gen(function* () {
			expect(yield* run("prd")).toBe("allowed")
			expect(yield* run("stg")).toBe("allowed")
			expect(observed).toEqual([
				makeApiV2RateLimitKey("prd", KEY_A),
				makeApiV2RateLimitKey("stg", KEY_A),
			])
		})
	})

	it.effect("returns limited when Cloudflare denies the key", () =>
		Effect.gen(function* () {
			const limiter = yield* ApiV2RateLimiter
			expect(yield* limiter.check(KEY_A)).toBe("limited")
		}).pipe(
			Effect.provide(
				limiterLayer({ partition: "prd", limit: () => Effect.succeed({ success: false }) }),
			),
		),
	)

	it.effect("fails open when the binding or partition is unavailable", () => {
		const run = (limiter: RateLimiter | undefined) =>
			Effect.gen(function* () {
				const limiter = yield* ApiV2RateLimiter
				return yield* limiter.check(KEY_A)
			}).pipe(Effect.provide(limiterLayer(limiter)))

		return Effect.gen(function* () {
			expect(yield* run(undefined)).toBe("failed_open")
			expect(yield* run({ partition: undefined, limit: () => Effect.succeed({ success: true }) })).toBe(
				"failed_open",
			)
		})
	})

	it.effect("fails open when the Cloudflare binding throws", () =>
		Effect.gen(function* () {
			const limiter = yield* ApiV2RateLimiter
			expect(yield* limiter.check(KEY_A)).toBe("failed_open")
		}).pipe(
			Effect.provide(
				limiterLayer({
					partition: "prd",
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
