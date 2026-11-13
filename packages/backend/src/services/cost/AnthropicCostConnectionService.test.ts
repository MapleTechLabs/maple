import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { AnthropicCostConnectionService } from "./AnthropicCostConnectionService"
import {
	FAKE_ORGANIZATION,
	type FakeAnthropic,
	fakeAnthropicDeps,
	makeFakeAnthropic,
} from "./providers/anthropic/fake-anthropic"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const USER = Schema.decodeSync(UserId)("user_cost")
const KEY = "sk-ant-admin01-0123456789abcdefghijABCDEFGHIJ0123456789-AbCdEfAA"
const OTHER_KEY = "sk-ant-admin01-9876543210zyxwvutsrqZYXWVUTSRQ9876543210-ZyXwVuAA"
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))
const VALIDATION = "@maple/http/cost-connections/CostConnectionValidationError"
const PERSISTENCE = "@maple/http/cost-connections/CostConnectionPersistenceError"

const run = <A, E>(
	testDb: TestDb,
	world: FakeAnthropic,
	effect: Effect.Effect<A, E, AnthropicCostConnectionService>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.effect(AnthropicCostConnectionService, AnthropicCostConnectionService.make).pipe(
				Layer.provide(fakeAnthropicDeps(testDb, world)),
			),
		),
	)

const set = (key: string) => AnthropicCostConnectionService.use((service) => service.set(ORG, USER, key))
const remove = AnthropicCostConnectionService.use((service) => service.remove(ORG))

interface Stored {
	readonly id: string
	readonly provider: string
	readonly secret_ciphertext: string
	readonly account_id: string
	readonly account_label: string
}

const storedKey = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<Stored>(
			testDb,
			"SELECT id, provider, secret_ciphertext, account_id, account_label FROM cost_connections WHERE org_id = 'org_cost'",
		),
	)

const source = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{
			readonly connection_ref: string
			readonly account_id: string
			readonly enabled: boolean
		}>(
			testDb,
			"SELECT connection_ref, account_id, enabled FROM cost_sources WHERE org_id = 'org_cost' AND provider = 'anthropic'",
		),
	)

describe("AnthropicCostConnectionService", () => {
	it.effect("checks a key with Anthropic, seals it and makes the cost source of its organization", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set(`  ${KEY}\n`)
				assert.deepStrictEqual(saved, { accountId: FAKE_ORGANIZATION.id, accountLabel: "Acme" })
				// Which organization, then proof the key reads its cost report for yesterday and today.
				assert.strictEqual(world.urls[0], "/v1/organizations/me")
				const report = new URL(`https://api.anthropic.com${world.urls[1] ?? ""}`)
				assert.strictEqual(report.pathname, "/v1/organizations/cost_report")
				assert.deepStrictEqual(Arr.fromIterable(report.searchParams), [
					["starting_at", "2026-11-10T00:00:00Z"],
					["ending_at", "2026-11-12T00:00:00Z"],
					["bucket_width", "1d"],
					["group_by[]", "workspace_id"],
					["group_by[]", "description"],
					["limit", "31"],
				])
				assert.deepStrictEqual(world.headers, Arr.replicate([KEY, "2023-06-01"], 2))

				const stored = yield* storedKey(testDb)
				assert.isFalse(Str.includes(KEY)(stored?.secret_ciphertext ?? KEY))
				assert.deepStrictEqual(
					[stored?.provider, stored?.account_id, stored?.account_label],
					["anthropic", FAKE_ORGANIZATION.id, "Acme"],
				)
				const made = yield* source(testDb)
				assert.deepStrictEqual(
					[made?.connection_ref, made?.account_id, made?.enabled],
					[stored?.id, FAKE_ORGANIZATION.id, true],
				)
			}),
		)
	})

	it.effect(
		"never sends text that is not an Admin API key, nor any key of an org outside the rollout",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeAnthropic()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const refusals = yield* Effect.forEach(
						[
							"",
							// A regular API key, which cannot read costs.
							"sk-ant-api03-0123456789abcdefghij",
							"sk-ant-admin",
							"sk-ant-admin01 two words",
							`sk-ant-admin01-${Str.repeat(600)("a")}`,
						],
						(text) => Effect.map(Effect.flip(set(text)), (error) => [error._tag, error.message]),
					)
					assert.deepStrictEqual(
						refusals,
						Arr.replicate(
							[
								VALIDATION,
								"That is not an Anthropic Admin API key. They start with sk-ant-admin.",
							],
							5,
						),
					)

					world.cloudCost = false
					const outside = yield* Effect.flip(set(KEY))
					assert.strictEqual(outside._tag, "@maple/http/errors/CloudCostDisabledError")
					assert.deepStrictEqual(world.urls, [])
					assert.isUndefined(yield* storedKey(testDb))
				}),
			)
		},
	)

	it.effect("refuses a key Anthropic rejects, and one that cannot read the cost report", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic({ meStatus: 401 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const rejected = yield* Effect.flip(set(KEY))
				assert.deepStrictEqual(
					[rejected._tag, rejected.message],
					[
						VALIDATION,
						"Anthropic rejected this key. Use an Admin API key from the Claude Console.",
					],
				)
				world.meStatus = 403
				assert.strictEqual(
					(yield* Effect.flip(set(KEY))).message,
					"Anthropic rejected this key. Use an Admin API key from the Claude Console.",
				)
				// Neither asked for costs.
				assert.deepStrictEqual(world.urls, Arr.replicate("/v1/organizations/me", 2))

				world.meStatus = 200
				world.costStatus = 403
				const noCosts = yield* Effect.flip(set(KEY))
				assert.deepStrictEqual(
					[noCosts._tag, noCosts.message],
					[VALIDATION, "This key cannot read the organization's costs. Use an Admin API key."],
				)
				assert.isUndefined(yield* storedKey(testDb))
			}),
		)
	})

	it.effect("reports an Anthropic outage as a retryable failure, not as a bad key", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic({ meStatus: 529 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.strictEqual((yield* Effect.flip(set(KEY)))._tag, PERSISTENCE)
				world.meStatus = 200
				world.costStatus = 500
				const failed = yield* Effect.flip(set(KEY))
				assert.deepStrictEqual(
					[failed._tag, failed.message],
					[PERSISTENCE, "Could not check this key with Anthropic. Try again."],
				)
				world.costStatus = 200
				world.buckets = "<html>maintenance</html>"
				assert.strictEqual((yield* Effect.flip(set(KEY)))._tag, PERSISTENCE)
				assert.isUndefined(yield* storedKey(testDb))
			}),
		)
	})

	it.effect("keeps the connection and its source when the organization's key is replaced", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(KEY)
				const first = yield* storedKey(testDb)
				const firstSource = yield* source(testDb)

				// The organization was renamed since: the label follows, the id is what is compared.
				world.organization = { id: FAKE_ORGANIZATION.id, name: "Acme Inc" }
				const replaced = yield* set(OTHER_KEY)
				assert.strictEqual(replaced.accountLabel, "Acme Inc")
				const second = yield* storedKey(testDb)
				assert.strictEqual(second?.id, first?.id)
				assert.strictEqual(second?.account_label, "Acme Inc")
				assert.notStrictEqual(second?.secret_ciphertext, first?.secret_ciphertext)
				assert.deepStrictEqual(yield* source(testDb), firstSource)
			}),
		)
	})

	it.effect("refuses a key of another organization while a source exists, and keeps the saved one", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(KEY)
				const first = yield* storedKey(testDb)

				world.organization = { id: "9a8b7c6d-0000-4000-8000-000000000000", name: "Other Org" }
				const refused = yield* Effect.flip(set(OTHER_KEY))
				assert.deepStrictEqual(
					[refused._tag, refused.message],
					[
						VALIDATION,
						"This key belongs to another Anthropic organization than the source does. Remove the source first to switch organizations.",
					],
				)
				assert.deepStrictEqual(yield* storedKey(testDb), first)
			}),
		)
	})

	it.effect("removes the key and its source together, without needing the rollout", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(KEY)
				world.cloudCost = false
				yield* remove
				assert.isUndefined(yield* storedKey(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})
})
