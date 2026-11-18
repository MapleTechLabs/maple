import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { ScraperEnv } from "./Env"

const loadEnv = (env: Record<string, string>) =>
	Effect.service(ScraperEnv).pipe(
		Effect.provide(ScraperEnv.layer),
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
	)

describe("ScraperEnv", () => {
	it.effect("accepts explicit valid numeric settings", () =>
		Effect.gen(function* () {
			const env = yield* loadEnv({ SCRAPER_CONCURRENCY: "25", PORT: "8080" })
			assert.strictEqual(env.SCRAPER_CONCURRENCY, 25)
			assert.strictEqual(env.PORT, 8080)
		}),
	)

	// SCRAPER_CONCURRENCY=0 built a semaphore that could never grant the one
	// permit each scrape requests — every target silently suspended while
	// /health kept returning 200. Startup is the only visible place to fail.
	it.effect("rejects a zero concurrency at layer build", () =>
		Effect.gen(function* () {
			const error = yield* loadEnv({ SCRAPER_CONCURRENCY: "0" }).pipe(Effect.flip)
			assert.strictEqual(error._tag, "ConfigError")
		}),
	)

	// A zero share would build per-org semaphores that never grant a permit: no check would run.
	it.effect("reads the per-org uptime share, and rejects a zero one at layer build", () =>
		Effect.gen(function* () {
			const env = yield* loadEnv({ UPTIME_ORG_CONCURRENCY: "7" })
			assert.strictEqual(env.UPTIME_ORG_CONCURRENCY, 7)
			const unset = yield* loadEnv({})
			assert.isBelow(unset.UPTIME_ORG_CONCURRENCY, unset.UPTIME_CONCURRENCY)
			// Unset, it follows the shared permits down, so another org always has one left.
			const lowered = yield* loadEnv({ UPTIME_CONCURRENCY: "4" })
			assert.strictEqual(lowered.UPTIME_ORG_CONCURRENCY, 2)
			const single = yield* loadEnv({ UPTIME_CONCURRENCY: "1" })
			assert.strictEqual(single.UPTIME_ORG_CONCURRENCY, 1)
			const error = yield* loadEnv({ UPTIME_ORG_CONCURRENCY: "0" }).pipe(Effect.flip)
			assert.strictEqual(error._tag, "ConfigError")
		}),
	)

	it.effect("rejects a fractional concurrency at layer build", () =>
		Effect.gen(function* () {
			const error = yield* loadEnv({ SCRAPER_CONCURRENCY: "0.5" }).pipe(Effect.flip)
			assert.strictEqual(error._tag, "ConfigError")
		}),
	)

	it.effect("rejects a non-positive reconcile interval", () =>
		Effect.gen(function* () {
			const error = yield* loadEnv({ SCRAPER_RECONCILE_INTERVAL_SECONDS: "-1" }).pipe(Effect.flip)
			assert.strictEqual(error._tag, "ConfigError")
		}),
	)

	it.effect("rejects a non-positive OTLP chunk size", () =>
		Effect.gen(function* () {
			const error = yield* loadEnv({ SCRAPER_OTLP_MAX_DATA_POINTS: "0" }).pipe(Effect.flip)
			assert.strictEqual(error._tag, "ConfigError")
		}),
	)

	it.effect("rejects a port outside the TCP range", () =>
		Effect.gen(function* () {
			const error = yield* loadEnv({ PORT: "70000" }).pipe(Effect.flip)
			assert.strictEqual(error._tag, "ConfigError")
		}),
	)
})
