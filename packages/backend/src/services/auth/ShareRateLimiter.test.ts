import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ApiV2RateLimit, ShareLinkRateLimit, type RateLimiter } from "@maple/backend/platform/bindings"
import { testEnv } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { API_V2_RATE_LIMIT_REQUESTS } from "./ApiV2RateLimiter"
import { SHARE_LINK_RATE_LIMIT_REQUESTS, ShareRateLimiter } from "./ShareRateLimiter"

/** A fixed-window binding: each key gets `limit` requests in the test's one window. */
const countingBinding = (limit: number): RateLimiter => {
	const counts = new Map<string, number>()
	return {
		limit: (key) =>
			Effect.sync(() => {
				const count = (counts.get(key) ?? 0) + 1
				counts.set(key, count)
				return { success: count <= limit }
			}),
	}
}

const limiterLayer = (bindings: { readonly link?: RateLimiter; readonly viewer?: RateLimiter }) =>
	ShareRateLimiter.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				bindings.link === undefined ? Layer.empty : Layer.succeed(ShareLinkRateLimit, bindings.link),
				bindings.viewer === undefined ? Layer.empty : Layer.succeed(ApiV2RateLimit, bindings.viewer),
			),
		),
		Layer.provide(testEnv({ MAPLE_ENVIRONMENT: "stg" })),
	)

const LINK = "a1b2c3d4e5f6a7b8c9d0e1f2"

describe("ShareRateLimiter", () => {
	it.effect("still serves a second viewer after one viewer exhausts its own budget", () =>
		Effect.gen(function* () {
			const limiter = yield* ShareRateLimiter
			const busy = { tokenHashPrefix: LINK, ip: "198.51.100.7" }
			yield* Effect.forEach(indices(API_V2_RATE_LIMIT_REQUESTS), () => limiter.check(busy), {
				discard: true,
			})

			expect(yield* limiter.check(busy)).toBe("limited")
			expect(yield* limiter.check({ tokenHashPrefix: LINK, ip: "203.0.113.9" })).toBe("allowed")
		}).pipe(
			Effect.provide(
				limiterLayer({
					link: countingBinding(SHARE_LINK_RATE_LIMIT_REQUESTS),
					viewer: countingBinding(API_V2_RATE_LIMIT_REQUESTS),
				}),
			),
		),
	)

	it.effect("never lets one viewer spend the link's whole budget", () =>
		Effect.gen(function* () {
			const limiter = yield* ShareRateLimiter
			const busy = { tokenHashPrefix: LINK, ip: "198.51.100.7" }
			yield* Effect.forEach(indices(SHARE_LINK_RATE_LIMIT_REQUESTS), () => limiter.check(busy), {
				discard: true,
			})

			expect(yield* limiter.check({ tokenHashPrefix: LINK, ip: "203.0.113.9" })).toBe("allowed")
		}).pipe(
			Effect.provide(
				limiterLayer({
					link: countingBinding(SHARE_LINK_RATE_LIMIT_REQUESTS),
					viewer: countingBinding(API_V2_RATE_LIMIT_REQUESTS),
				}),
			),
		),
	)

	it.effect("limits the link once its aggregate budget is spent, whoever is asking", () =>
		Effect.gen(function* () {
			const limiter = yield* ShareRateLimiter
			yield* Effect.forEach(
				indices(SHARE_LINK_RATE_LIMIT_REQUESTS),
				(i) => limiter.check({ tokenHashPrefix: LINK, ip: `10.0.${Math.floor(i / 250)}.${i % 250}` }),
				{ discard: true },
			)

			expect(yield* limiter.check({ tokenHashPrefix: LINK, ip: "203.0.113.9" })).toBe("limited")
			expect(yield* limiter.check({ tokenHashPrefix: "f".repeat(24), ip: "203.0.113.9" })).toBe(
				"allowed",
			)
		}).pipe(
			Effect.provide(
				limiterLayer({
					link: countingBinding(SHARE_LINK_RATE_LIMIT_REQUESTS),
					viewer: countingBinding(API_V2_RATE_LIMIT_REQUESTS),
				}),
			),
		),
	)

	it.effect("skips the viewer bucket without a client IP", () =>
		Effect.gen(function* () {
			const limiter = yield* ShareRateLimiter
			expect(yield* limiter.check({ tokenHashPrefix: LINK, ip: undefined })).toBe("allowed")
		}).pipe(
			Effect.provide(
				limiterLayer({
					link: countingBinding(SHARE_LINK_RATE_LIMIT_REQUESTS),
					viewer: { limit: () => Effect.die("no IP, so no viewer bucket") },
				}),
			),
		),
	)

	it.effect("fails open when the link binding is missing", () =>
		Effect.gen(function* () {
			const limiter = yield* ShareRateLimiter
			expect(yield* limiter.check({ tokenHashPrefix: LINK, ip: undefined })).toBe("failed_open")
		}).pipe(Effect.provide(limiterLayer({ viewer: countingBinding(API_V2_RATE_LIMIT_REQUESTS) }))),
	)
})

/** `n` indices, for issuing n requests. */
const indices = (n: number): ReadonlyArray<number> => Array.from({ length: n }, (_, i) => i)
