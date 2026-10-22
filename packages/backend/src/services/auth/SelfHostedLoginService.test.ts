import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	BASE_LOCKOUT_MS,
	CLIENT_MAX_FAILURES,
	GLOBAL_MAX_FAILURES,
	SelfHostedLoginService,
} from "./SelfHostedLoginService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const PASSWORD = "test-root-password"

const makeLayer = (testDb: TestDb) =>
	SelfHostedLoginService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(
			Env.layer.pipe(
				Layer.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							TINYBIRD_HOST: "https://api.tinybird.co",
							TINYBIRD_TOKEN: "test-token",
							MAPLE_AUTH_MODE: "self_hosted",
							MAPLE_ROOT_PASSWORD: PASSWORD,
							MAPLE_DEFAULT_ORG_ID: "default",
							MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
							MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
						}),
					),
				),
			),
		),
	)

const failTimes = (count: number, client: (index: number) => string) =>
	Effect.gen(function* () {
		const service = yield* SelfHostedLoginService
		return yield* Effect.forEach(
			Array.from({ length: count }, (_, index) => index),
			(index) =>
				service.login("wrong-password", client(index)).pipe(
					Effect.flip,
					Effect.map((error) => error._tag),
				),
		)
	})

describe("SelfHostedLoginService", () => {
	it.effect("signs in with the right password on the first try", () =>
		Effect.gen(function* () {
			const service = yield* SelfHostedLoginService
			const response = yield* service.login(PASSWORD, "203.0.113.7")
			expect(response.orgId).toBe("default")
			expect(response.token.length).toBeGreaterThan(0)
		}).pipe(Effect.provide(makeLayer(createTestDb(createdDbs)))),
	)

	it.effect("refuses even the right password after repeated failures until the lockout passes", () =>
		Effect.gen(function* () {
			const service = yield* SelfHostedLoginService
			const tags = yield* failTimes(CLIENT_MAX_FAILURES, () => "203.0.113.7")
			expect(tags).toEqual(
				Array(CLIENT_MAX_FAILURES).fill("@maple/http/errors/SelfHostedInvalidPasswordError"),
			)

			const refused = yield* Effect.flip(service.login(PASSWORD, "203.0.113.7"))
			expect(refused._tag).toBe("@maple/http/errors/SelfHostedLoginThrottledError")

			// Another client is not locked out by this one's failures.
			const other = yield* service.login(PASSWORD, "198.51.100.4")
			expect(other.orgId).toBe("default")

			yield* TestClock.adjust(BASE_LOCKOUT_MS + 1000)
			const afterLockout = yield* service.login(PASSWORD, "203.0.113.7")
			expect(afterLockout.orgId).toBe("default")
		}).pipe(Effect.provide(makeLayer(createTestDb(createdDbs)))),
	)

	it.effect("doubles the lockout when failures continue right after one expires", () =>
		Effect.gen(function* () {
			const service = yield* SelfHostedLoginService
			yield* failTimes(CLIENT_MAX_FAILURES, () => "203.0.113.7")
			yield* TestClock.adjust(BASE_LOCKOUT_MS + 1000)
			yield* failTimes(1, () => "203.0.113.7")

			yield* TestClock.adjust(BASE_LOCKOUT_MS + 1000)
			const stillLocked = yield* Effect.flip(service.login(PASSWORD, "203.0.113.7"))
			expect(stillLocked._tag).toBe("@maple/http/errors/SelfHostedLoginThrottledError")
		}).pipe(Effect.provide(makeLayer(createTestDb(createdDbs)))),
	)

	it.effect("lets no more than the limit through a concurrent burst", () =>
		Effect.gen(function* () {
			const service = yield* SelfHostedLoginService
			const tags = yield* Effect.forEach(
				Array.from({ length: 20 }, (_, index) => index),
				() =>
					service.login("wrong-password", "203.0.113.7").pipe(
						Effect.flip,
						Effect.map((error) => error._tag),
					),
				{ concurrency: "unbounded" },
			)
			const checked = tags.filter((tag) => tag === "@maple/http/errors/SelfHostedInvalidPasswordError")
			expect(checked.length).toBe(CLIENT_MAX_FAILURES)
		}).pipe(Effect.provide(makeLayer(createTestDb(createdDbs)))),
	)

	it.effect("locks the root account when failures spread across many clients", () =>
		Effect.gen(function* () {
			const service = yield* SelfHostedLoginService
			yield* failTimes(GLOBAL_MAX_FAILURES, (index) => `10.0.${Math.floor(index / 200)}.${index % 200}`)

			const refused = yield* Effect.flip(service.login(PASSWORD, "192.0.2.10"))
			expect(refused._tag).toBe("@maple/http/errors/SelfHostedLoginThrottledError")
		}).pipe(Effect.provide(makeLayer(createTestDb(createdDbs)))),
	)
})
