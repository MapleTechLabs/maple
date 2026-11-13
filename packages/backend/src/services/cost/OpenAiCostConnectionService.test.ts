import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { OpenAiCostConnectionService } from "./OpenAiCostConnectionService"
import {
	FAKE_OPENAI_ORG,
	type FakeOpenAi,
	fakeOpenAiDeps,
	makeFakeOpenAi,
} from "./providers/openai/fake-openai"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const USER = Schema.decodeSync(UserId)("user_cost")
const KEY = "sk-admin-0123456789abcdefghijABCDEFGHIJ0123456789"
const OTHER_KEY = "sk-admin-9876543210zyxwvutsrqZYXWVUTSRQ9876543210"
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))
const SPEND = [{ day: "2026-10-20", value: 1.5, lineItem: "gpt-4o, input" }]
const VALIDATION = "@maple/http/cost-connections/CostConnectionValidationError"
const PERSISTENCE = "@maple/http/cost-connections/CostConnectionPersistenceError"
const unix = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000

const run = <A, E>(
	testDb: TestDb,
	world: FakeOpenAi,
	effect: Effect.Effect<A, E, OpenAiCostConnectionService>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.effect(OpenAiCostConnectionService, OpenAiCostConnectionService.make).pipe(
				Layer.provide(fakeOpenAiDeps(testDb, world)),
			),
		),
	)

const set = (key: string) => OpenAiCostConnectionService.use((service) => service.set(ORG, USER, key))
const remove = OpenAiCostConnectionService.use((service) => service.remove(ORG))

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
		queryFirstRow<{ connection_ref: string; account_id: string; enabled: boolean }>(
			testDb,
			"SELECT connection_ref, account_id, enabled FROM cost_sources WHERE org_id = 'org_cost' AND provider = 'openai'",
		),
	)

describe("OpenAiCostConnectionService", () => {
	it.effect("checks a key against the last 180 days of costs, seals it and makes the cost source", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenAi({ costs: SPEND })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set(`  ${KEY}  `)
				// The organization is only named on the key's own cost results.
				assert.deepStrictEqual(saved, { accountId: FAKE_OPENAI_ORG, accountLabel: FAKE_OPENAI_ORG })
				assert.deepStrictEqual(world.urls, [
					`/v1/organization/costs?start_time=${unix("2026-05-16")}&end_time=${unix("2026-11-12")}&bucket_width=1d&limit=180`,
				])
				assert.deepStrictEqual(world.authorizations, [`Bearer ${KEY}`])

				const stored = yield* storedKey(testDb)
				assert.isFalse(Str.includes(KEY)(stored?.secret_ciphertext ?? KEY))
				assert.deepStrictEqual(
					[stored?.provider, stored?.account_id, stored?.account_label],
					["openai", FAKE_OPENAI_ORG, FAKE_OPENAI_ORG],
				)
				const made = yield* source(testDb)
				assert.deepStrictEqual(
					[made?.connection_ref, made?.account_id, made?.enabled],
					[stored?.id, FAKE_OPENAI_ORG, true],
				)
			}),
		)
	})

	it.effect(
		"never sends text that is not an Admin API key, nor any key of an org outside the rollout",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeOpenAi({ costs: SPEND })
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const refusals = yield* Effect.forEach(
						[
							"",
							"   ",
							// A project key reads no organization costs.
							"sk-proj-0123456789abcdef",
							"sk-admin-",
							"sk-admin-two words",
							`sk-admin-${Str.repeat(600)("a")}`,
							"sk-admin-line\nbreak",
						],
						(text) => Effect.map(Effect.flip(set(text)), (error) => [error._tag, error.message]),
					)
					assert.deepStrictEqual(
						refusals,
						Arr.replicate(
							[VALIDATION, "That is not an OpenAI Admin API key. They start with sk-admin-."],
							7,
						),
					)

					world.cloudCost = false
					const outside = yield* Effect.flip(set(KEY))
					assert.strictEqual(outside._tag, "@maple/http/errors/CloudCostDisabledError")
					assert.deepStrictEqual(world.urls, [])
				}),
			)
		},
	)

	it.effect("refuses a key OpenAI rejects or that cannot read costs, and stores nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenAi({ costs: SPEND })
		const refusedWith = (status: number) =>
			Effect.gen(function* () {
				world.status = status
				const error = yield* Effect.flip(set(KEY))
				return [error._tag, error.message]
			})
		const rejected = "OpenAI rejected this key. Use an Admin API key from the organization's settings."
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* refusedWith(401), [VALIDATION, rejected])
				assert.deepStrictEqual(yield* refusedWith(400), [VALIDATION, rejected])
				assert.deepStrictEqual(yield* refusedWith(403), [
					VALIDATION,
					"This key cannot read the organization's costs. Use an Admin API key.",
				])
				// An outage or a limit says nothing about the key: it is a retry, not a refusal.
				assert.deepStrictEqual(yield* refusedWith(503), [
					PERSISTENCE,
					"Could not check this key with OpenAI. Try again.",
				])
				assert.strictEqual((yield* refusedWith(429))[0], PERSISTENCE)
				assert.isUndefined(yield* storedKey(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("refuses a key whose organization has spent nothing, since no result names it", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenAi()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const error = yield* Effect.flip(set(KEY))
				assert.deepStrictEqual(
					[error._tag, error.message],
					[
						VALIDATION,
						"This OpenAI organization has no API spend in the last 180 days, so there is nothing to read yet.",
					],
				)
				// Spend older than the 180 days read does not count.
				world.costs = [{ day: "2026-05-15", value: 1 }]
				assert.include((yield* Effect.flip(set(KEY))).message, "no API spend")
				assert.isUndefined(yield* storedKey(testDb))
			}),
		)
	})

	it.effect("takes the organization from the openai-organization header first, also with no spend", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenAi({ organizationHeader: "org-FromHeader0000" })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				// No spend, but OpenAI names the organization: there is an account to read from.
				assert.deepStrictEqual(yield* set(KEY), {
					accountId: "org-FromHeader0000",
					accountLabel: "org-FromHeader0000",
				})
			}),
		)
	})

	it.effect("refuses a key with spend whose organization OpenAI does not name, saying so", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenAi({ costs: [{ day: "2026-10-20", value: 1, organizationId: "" }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const error = yield* Effect.flip(set(KEY))
				assert.deepStrictEqual(
					[error._tag, error.message],
					[
						VALIDATION,
						"OpenAI did not say which organization this key belongs to, so Maple cannot add it yet.",
					],
				)
				assert.isUndefined(yield* storedKey(testDb))
			}),
		)
	})

	it.effect(
		"refuses a key whose costs name two organizations, since either could be the one it reads",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeOpenAi({
				costs: [
					...SPEND,
					{ day: "2026-10-21", value: 2, organizationId: "org-SecondOrganization0000" },
				],
			})
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const error = yield* Effect.flip(set(KEY))
					assert.strictEqual(error._tag, VALIDATION)
					assert.include(error.message, "more than one organization")
					assert.isUndefined(yield* storedKey(testDb))
				}),
			)
		},
	)

	it.effect(
		"keeps the connection when the organization's key is replaced, and refuses another organization's",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeOpenAi({ costs: SPEND })
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* set(KEY)
					const first = yield* storedKey(testDb)
					const firstSource = yield* source(testDb)

					yield* set(OTHER_KEY)
					const replaced = yield* storedKey(testDb)
					assert.strictEqual(replaced?.id, first?.id)
					assert.notStrictEqual(replaced?.secret_ciphertext, first?.secret_ciphertext)
					assert.deepStrictEqual(yield* source(testDb), firstSource)

					// Another organization's spend would overwrite the days the source already holds.
					world.organizationId = "org-SecondOrganization0000"
					const refused = yield* Effect.flip(set(KEY))
					assert.deepStrictEqual(
						[refused._tag, refused.message],
						[
							VALIDATION,
							"This key belongs to another OpenAI organization than the source does. Remove the source first to switch organizations.",
						],
					)
					assert.deepStrictEqual(yield* storedKey(testDb), replaced)
				}),
			)
		},
	)

	it.effect("removes the key and its source together, without needing the rollout", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenAi({ costs: SPEND })
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
