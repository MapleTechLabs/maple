import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { MobileDevices } from "@maple/db/tables"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Array as Arr, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { MobileDevicesService } from "./MobileDevicesService"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const ORG = OrgId.make("org_push_test")
const OTHER_ORG = OrgId.make("org_push_other")
const USER = UserId.make("user_push_test")
const REGISTERED_MS = Date.UTC(2026, 6, 6, 9, 0, 0)
const PUSHED_MS = REGISTERED_MS + 60_000

const makeLayer = () => MobileDevicesService.layer.pipe(Layer.provideMerge(createTestDb(createdDbs).layer))

const register = (orgId: OrgId, token: string) =>
	Effect.gen(function* () {
		const devices = yield* MobileDevicesService
		return yield* devices.register(orgId, USER, {
			platform: "ios",
			token,
			environment: "production",
			bundleId: "com.maple.mobile",
		})
	})

/** `lastPushedAt` by token, read from the table: the service does not expose it. */
const lastPushedByToken = Effect.gen(function* () {
	const database = yield* Database
	const rows = yield* database.execute((db) =>
		db.run(PG.from(MobileDevices).select("token", "lastPushedAt").orderBy(["token", "asc"])),
	)
	return Arr.map(rows, (row) => [row.token, row.lastPushedAt] as const)
})

describe("MobileDevicesService.markPushed", () => {
	it.effect("stamps every named device of the org and no other row", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(REGISTERED_MS)
			const devices = yield* MobileDevicesService
			const first = yield* register(ORG, "token-a")
			const second = yield* register(ORG, "token-b")
			yield* register(ORG, "token-c")
			const foreign = yield* register(OTHER_ORG, "token-d")

			yield* TestClock.setTime(PUSHED_MS)
			// The other org's device id is named too: the write stays inside the org.
			yield* devices.markPushed(ORG, [first.id, second.id, foreign.id])

			assert.deepStrictEqual(yield* lastPushedByToken, [
				["token-a", PUSHED_MS],
				["token-b", PUSHED_MS],
				["token-c", null],
				["token-d", null],
			])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("writes nothing for an empty list", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(REGISTERED_MS)
			const devices = yield* MobileDevicesService
			yield* register(ORG, "token-a")

			yield* TestClock.setTime(PUSHED_MS)
			yield* devices.markPushed(ORG, [])

			assert.deepStrictEqual(yield* lastPushedByToken, [["token-a", null]])
		}).pipe(Effect.provide(makeLayer())),
	)
})
