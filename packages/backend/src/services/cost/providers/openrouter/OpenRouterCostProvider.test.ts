import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import type { CostProviderError } from "../../CostProvider"
import { OpenRouterCostConnectionService } from "../../OpenRouterCostConnectionService"
import { type FakeOpenRouter, fakeOpenRouterDeps, makeFakeOpenRouter } from "./fake-openrouter"
import { OpenRouterCostProvider } from "./OpenRouterCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_cost")
const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef"
const WINDOW = { startDay: "2026-11-01", endDay: "2026-11-03" }
/** The pull runs the morning after the window's last day. */
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-04T06:00:00Z"))

const run = <A, E>(
	testDb: TestDb,
	world: FakeOpenRouter,
	effect: Effect.Effect<A, E, OpenRouterCostProvider | OpenRouterCostConnectionService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(OpenRouterCostProvider, OpenRouterCostProvider.make),
				Layer.effect(OpenRouterCostConnectionService, OpenRouterCostConnectionService.make),
			).pipe(Layer.provide(fakeOpenRouterDeps(testDb, world))),
		),
	)

/** Saves `KEY` for `ORG` and answers the connection's id, with the fake's call log emptied. */
const saveKey = (testDb: TestDb, world: FakeOpenRouter) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		yield* OpenRouterCostConnectionService.use((service) => service.set(ORG, USER, KEY))
		const row = yield* Effect.promise(() =>
			queryFirstRow<{ id: string }>(testDb, "SELECT id FROM openrouter_cost_connections"),
		)
		world.urls.length = 0
		world.authorizations.length = 0
		return row?.id ?? ""
	})

const pull = (orgId: OrgId, connectionRef: string) =>
	OpenRouterCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, WINDOW))

const reasonOf = (error: CostProviderError) => [error.reason, error.requests, error.provider]

describe("OpenRouterCostProvider", () => {
	it.effect("reads the account's activity with the saved key and returns the window's days", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter({
			activity: [
				{
					date: "2026-11-02",
					model: "anthropic/claude-sonnet-5",
					provider_name: "Anthropic",
					usage: 2.5,
					prompt_tokens: 100,
					completion_tokens: 50,
				},
				{ date: "2026-11-03", model: "openai/gpt-5", provider_name: null, usage: 4 },
				{ date: "2026-10-20", model: "openai/gpt-5", provider_name: "OpenAI", usage: 9 },
			],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				const pulled = yield* pull(ORG, connectionRef)
				// One request whatever the window, on the global host, and OpenRouter bills none.
				assert.deepStrictEqual(world.urls, ["https://openrouter.ai/api/v1/activity"])
				assert.deepStrictEqual(world.authorizations, [`Bearer ${KEY}`])
				assert.strictEqual(pulled.requests, 0)
				// Rows carry the key's account, and yesterday's can still change.
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [
						row.day,
						row.cloudService,
						row.billedCost,
						row.accountId,
						row.estimated,
					]),
					[
						["2026-11-02", "anthropic/claude-sonnet-5", 2.5, "user_account_a", false],
						["2026-11-03", "openai/gpt-5", 4, "user_account_a", true],
					],
				)
			}),
		)
	})

	it.effect("says what the sync should do about each way OpenRouter refuses", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				const reasons = yield* Effect.forEach([401, 403, 429, 502], (status) =>
					Effect.gen(function* () {
						world.activityStatus = status
						return (yield* Effect.flip(pull(ORG, connectionRef))).reason
					}),
				)
				assert.deepStrictEqual(reasons, ["auth", "not_ready", "rate_limited", "upstream"])
			}),
		)
	})

	it.effect("fails an answer it cannot read as invalid, with nothing to store", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				world.activity = "<html>maintenance</html>"
				assert.deepStrictEqual(reasonOf(yield* Effect.flip(pull(ORG, connectionRef))), [
					"invalid_response",
					0,
					"openrouter",
				])
				world.activity = [{ date: "soon", model: "m", provider_name: "p", usage: 1 }]
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
			}),
		)
	})

	it.effect("is built on a deployment whose secret key is unusable, and fails only its own pulls", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter()
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				testDb.pglite.query(
					`INSERT INTO openrouter_cost_connections
					   (id, org_id, key_ciphertext, key_iv, key_tag, key_label, account_id, created_at, updated_at, updated_by)
					 VALUES ('conn_a', 'org_cost', 'sealed', 'iv', 'tag', 'sk-or-v1-abc...123', 'user_account_a', now(), now(), 'user_cost')`,
				),
			)
			const error = yield* Effect.flip(pull(ORG, "conn_a"))
			assert.deepStrictEqual([error.reason, world.urls], ["auth", []])
		}).pipe(
			Effect.provide(
				Layer.effect(OpenRouterCostProvider, OpenRouterCostProvider.make).pipe(
					Layer.provide(fakeOpenRouterDeps(testDb, world, "not-a-32-byte-key")),
				),
			),
		)
	})

	it.effect("never reads a key through another org's source, or a connection that is gone", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter()
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
