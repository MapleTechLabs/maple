import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Env } from "@maple/backend/platform/Env"
import {
	RateLimitBindingError,
	type RateLimiter,
	SelfHostedLoginRateLimit,
} from "@maple/backend/platform/bindings"
import {
	SELF_HOSTED_LOGIN_RATE_LIMIT_ATTEMPTS,
	SELF_HOSTED_LOGIN_RATE_LIMIT_PERIOD_SECONDS,
	SelfHostedLoginRateLimiter,
} from "./SelfHostedLoginRateLimiter"

const envLayer = Env.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				TINYBIRD_HOST: "https://api.tinybird.co",
				TINYBIRD_TOKEN: "test-token",
				MAPLE_AUTH_MODE: "self_hosted",
				MAPLE_ROOT_PASSWORD: "test-root-password",
				MAPLE_DEFAULT_ORG_ID: "default",
				MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
				MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			}),
		),
	),
)

const inProcess = SelfHostedLoginRateLimiter.layer.pipe(Layer.provide(envLayer))
const withBinding = (binding: RateLimiter) =>
	SelfHostedLoginRateLimiter.layer.pipe(
		Layer.provide(Layer.mergeAll(envLayer, Layer.succeed(SelfHostedLoginRateLimit, binding))),
	)

const spend = (clientKey: string, times: number) =>
	Effect.gen(function* () {
		const limiter = yield* SelfHostedLoginRateLimiter
		yield* Effect.forEach(Array.from({ length: times }), () => limiter.check(clientKey), {
			discard: true,
		})
	})

describe("SelfHostedLoginRateLimiter", () => {
	it.effect("refuses a client past the limit and lets it back in after the window", () =>
		Effect.gen(function* () {
			const limiter = yield* SelfHostedLoginRateLimiter
			yield* spend("203.0.113.7", SELF_HOSTED_LOGIN_RATE_LIMIT_ATTEMPTS)

			const refused = yield* Effect.flip(limiter.check("203.0.113.7"))
			expect(refused._tag).toBe("@maple/http/errors/SelfHostedLoginRateLimitError")
			expect(refused.retryAfterSeconds).toBe(SELF_HOSTED_LOGIN_RATE_LIMIT_PERIOD_SECONDS)

			// Another client keeps its own budget.
			yield* limiter.check("198.51.100.4")

			yield* TestClock.adjust(`${SELF_HOSTED_LOGIN_RATE_LIMIT_PERIOD_SECONDS} seconds`)
			yield* limiter.check("203.0.113.7")
		}).pipe(Effect.provide(inProcess)),
	)

	it.effect("refuses when the binding says the client is over its limit", () =>
		Effect.gen(function* () {
			const limiter = yield* SelfHostedLoginRateLimiter
			const refused = yield* Effect.flip(limiter.check("203.0.113.7"))
			expect(refused.retryAfterSeconds).toBe(SELF_HOSTED_LOGIN_RATE_LIMIT_PERIOD_SECONDS)
		}).pipe(Effect.provide(withBinding({ limit: () => Effect.succeed({ success: false }) }))),
	)

	it.effect("falls back to the in-process limit when the binding fails", () =>
		Effect.gen(function* () {
			const limiter = yield* SelfHostedLoginRateLimiter
			yield* spend("203.0.113.7", SELF_HOSTED_LOGIN_RATE_LIMIT_ATTEMPTS)
			const refused = yield* Effect.flip(limiter.check("203.0.113.7"))
			expect(refused._tag).toBe("@maple/http/errors/SelfHostedLoginRateLimitError")
		}).pipe(
			Effect.provide(
				withBinding({
					limit: () =>
						Effect.fail(new RateLimitBindingError({ message: "down", cause: undefined })),
				}),
			),
		),
	)
})
