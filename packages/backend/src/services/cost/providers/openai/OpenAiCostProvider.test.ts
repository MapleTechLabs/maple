import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { OpenAiCostConnectionService } from "../../OpenAiCostConnectionService"
import { FAKE_OPENAI_ORG, type FakeOpenAi, fakeOpenAiDeps, makeFakeOpenAi } from "./fake-openai"
import { OpenAiCostProvider } from "./OpenAiCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_cost")
const KEY = "sk-admin-0123456789abcdefghijABCDEFGHIJ0123456789"
const WINDOW = { startDay: "2026-10-20", endDay: "2026-11-10" }
/** The pull runs the morning after the window's last day. */
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))
const unix = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000

const run = <A, E>(
	testDb: TestDb,
	world: FakeOpenAi,
	effect: Effect.Effect<A, E, OpenAiCostProvider | OpenAiCostConnectionService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(OpenAiCostProvider, OpenAiCostProvider.make),
				Layer.effect(OpenAiCostConnectionService, OpenAiCostConnectionService.make),
			).pipe(Layer.provide(fakeOpenAiDeps(testDb, world))),
		),
	)

/** Saves `KEY` for `ORG` and answers the connection's id, with the fake's call log emptied. */
const saveKey = (testDb: TestDb, world: FakeOpenAi) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		yield* OpenAiCostConnectionService.use((service) => service.set(ORG, USER, KEY))
		const row = yield* Effect.promise(() =>
			queryFirstRow<{ id: string }>(testDb, "SELECT id FROM cost_connections"),
		)
		world.urls.length = 0
		world.authorizations.length = 0
		return row?.id ?? ""
	})

const pull = (orgId: OrgId, connectionRef: string, window = WINDOW) =>
	OpenAiCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

describe("OpenAiCostProvider", () => {
	it.effect("reads every page of the window's costs by project and line item", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenAi({
			costs: [
				{ day: "2026-10-19", value: 9, lineItem: "gpt-4o, input", projectId: "proj_a" },
				{ day: "2026-10-20", value: 1.5, lineItem: "gpt-4o, input", projectId: "proj_a" },
				{ day: "2026-10-31", value: 2, lineItem: "gpt-4o, output", projectId: "proj_b" },
				// The window's last day is only served when the range ends the day after.
				{ day: "2026-11-10", value: 0.25, lineItem: "o3, input", projectId: null },
			],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				world.pageSize = 10
				const pulled = yield* pull(ORG, connectionRef)
				const query = `start_time=${unix("2026-10-20")}&end_time=${unix("2026-11-11")}&bucket_width=1d&group_by%5B%5D=project_id&group_by%5B%5D=line_item&limit=180`
				// 22 days at 10 a page, each next page by the cursor the one before gave.
				assert.deepStrictEqual(world.urls, [
					`/v1/organization/costs?${query}`,
					`/v1/organization/costs?${query}&page=page_10`,
					`/v1/organization/costs?${query}&page=page_20`,
				])
				assert.deepStrictEqual(world.authorizations, Arr.replicate(`Bearer ${KEY}`, 3))
				// OpenAI bills none of the requests.
				assert.strictEqual(pulled.requests, 0)
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [
						row.day,
						row.cloudService,
						row.resourceId,
						row.billedCost,
						row.accountId,
						row.estimated,
					]),
					[
						["2026-10-20", "openai/gpt-4o", "proj_a", 1.5, FAKE_OPENAI_ORG, false],
						["2026-10-31", "openai/gpt-4o", "proj_b", 2, FAKE_OPENAI_ORG, false],
						["2026-11-10", "openai/o3", "", 0.25, FAKE_OPENAI_ORG, true],
					],
				)
			}),
		)
	})

	it.effect(
		"fails a window whose costs take more pages than a pull reads, or that page without a cursor",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeOpenAi({
				costs: [{ day: "2026-10-20", value: 1, lineItem: "gpt-4o, input" }],
			})
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const connectionRef = yield* saveKey(testDb, world)
					world.pageSize = 1
					const tooLarge = yield* Effect.flip(
						pull(ORG, connectionRef, { startDay: "2026-08-01", endDay: "2026-11-10" }),
					)
					assert.deepStrictEqual([tooLarge.reason, tooLarge.provider], ["too_large", "openai"])
					// It stops at the cap rather than reading on.
					assert.lengthOf(world.urls, 60)

					// More to read and no way to read it: part of the window is not the window.
					world.pageSize = 10
					world.dropCursor = true
					assert.strictEqual(
						(yield* Effect.flip(pull(ORG, connectionRef))).reason,
						"invalid_response",
					)

					// A next page that is the page just read would repeat it: the pull stops at once.
					world.dropCursor = false
					world.repeatCursor = true
					world.urls.length = 0
					assert.strictEqual(
						(yield* Effect.flip(pull(ORG, connectionRef))).reason,
						"invalid_response",
					)
					assert.lengthOf(world.urls, 2)
				}),
			)
		},
	)

	it.effect("says what the sync should do about each way OpenAI refuses", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenAi({ costs: [{ day: "2026-10-20", value: 1 }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				const failures = yield* Effect.forEach([401, 403, 400, 429, 502], (status) =>
					Effect.gen(function* () {
						world.status = status
						const error = yield* Effect.flip(pull(ORG, connectionRef))
						return [error.reason, error.requests]
					}),
				)
				assert.deepStrictEqual(failures, [
					["auth", 0],
					["not_ready", 0],
					["upstream", 0],
					["rate_limited", 0],
					["upstream", 0],
				])
			}),
		)
	})

	it.effect("fails an answer it cannot read as invalid, with nothing to store", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenAi({ costs: [{ day: "2026-10-20", value: 1 }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				world.costs = "<html>maintenance</html>"
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
				// A page without its buckets is not read as a day with no cost.
				world.costs = '{"object":"page","has_more":false}'
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
				// An amount past what a number holds cannot be stored as cost.
				world.costs = `{"data":[{"start_time":${unix("2026-10-21")},"end_time":${unix("2026-10-22")},"results":[{"amount":{"value":1e999}}]}],"has_more":false}`
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
			}),
		)
	})

	it.effect("never reads a key through another org's source, or a connection that is gone", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenAi({ costs: [{ day: "2026-10-20", value: 1 }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				assert.strictEqual((yield* Effect.flip(pull(OTHER_ORG, connectionRef))).reason, "auth")
				assert.strictEqual((yield* Effect.flip(pull(ORG, "no-such-connection"))).reason, "auth")
				assert.deepStrictEqual(world.urls, [])
			}),
		)
	})
})
