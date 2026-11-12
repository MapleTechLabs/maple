import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { CloudflareCostConnectionService } from "../../CloudflareCostConnectionService"
import type { CostProviderError } from "../../CostProvider"
import { CloudflareCostProvider } from "./CloudflareCostProvider"
import {
	FAKE_ACCOUNT,
	type FakeCloudflare,
	fakeCloudflareDeps,
	makeFakeCloudflare,
	usageRow,
} from "./fake-cloudflare"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_cost")
const TOKEN = "cfut_0123456789abcdefghijABCDEFGHIJ0123456789"
const ACCOUNT_PATH = `/client/v4/accounts/${FAKE_ACCOUNT.id}`
const WINDOW = { startDay: "2026-10-20", endDay: "2026-11-10" }
/** The pull runs the morning after the window's last day. */
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))

const run = <A, E>(
	testDb: TestDb,
	world: FakeCloudflare,
	effect: Effect.Effect<A, E, CloudflareCostProvider | CloudflareCostConnectionService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(CloudflareCostProvider, CloudflareCostProvider.make),
				Layer.effect(CloudflareCostConnectionService, CloudflareCostConnectionService.make),
			).pipe(Layer.provide(fakeCloudflareDeps(testDb, world))),
		),
	)

/** Saves `TOKEN` for `ORG` and answers the connection's id, with the fake's call log emptied. */
const saveToken = (testDb: TestDb, world: FakeCloudflare) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		yield* CloudflareCostConnectionService.use((service) => service.set(ORG, USER, TOKEN))
		const row = yield* Effect.promise(() =>
			queryFirstRow<{ id: string }>(testDb, "SELECT id FROM cost_connections"),
		)
		world.urls.length = 0
		world.authorizations.length = 0
		return row?.id ?? ""
	})

const pull = (orgId: OrgId, connectionRef: string, window = WINDOW) =>
	CloudflareCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

const reasonOf = (error: CostProviderError) => [error.reason, error.requests, error.provider]

describe("CloudflareCostProvider", () => {
	it.effect(
		"reads usage from before the window's billing period started, and keeps the window's days",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeCloudflare({
				usage: [
					// October's period started on the 1st: a range starting on the 20th would miss it.
					usageRow("2026-10-19", "R2", "R2 Storage", 9),
					usageRow("2026-10-20", "R2", "R2 Storage", 1.5),
					usageRow("2026-10-31", "Workers", "Workers Requests", 0),
					usageRow("2026-11-09", "Workers", "Workers Requests", 2),
					// The window's last day is only served when the range ends the day after.
					usageRow("2026-11-10", "D1", "D1 Rows Read", 0.25),
				],
				subscriptions: [
					{
						price: 5,
						currency: "USD",
						frequency: "monthly",
						current_period_start: "2026-11-01T00:00:00Z",
						created_date: "2025-01-01T00:00:00Z",
						rate_plan: { public_name: "Workers Paid" },
					},
				],
			})
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const connectionRef = yield* saveToken(testDb, world)
					const pulled = yield* pull(ORG, connectionRef)
					assert.deepStrictEqual(world.urls, [
						`${ACCOUNT_PATH}/billable-usage/info`,
						`${ACCOUNT_PATH}/billable-usage?from=2026-09-19&to=2026-11-11`,
						`${ACCOUNT_PATH}/subscriptions?per_page=50&page=1`,
					])
					assert.deepStrictEqual(world.authorizations, Arr.replicate(`Bearer ${TOKEN}`, 3))
					// Cloudflare bills none of the requests.
					assert.strictEqual(pulled.requests, 0)
					assert.deepStrictEqual(
						Arr.map(pulled.rows, (row) => [
							row.day,
							row.cloudService,
							row.chargeCategory,
							row.billedCost,
							row.accountId,
							row.estimated,
						]),
						[
							["2026-10-20", "R2", "usage", 1.5, FAKE_ACCOUNT.id, false],
							["2026-11-09", "Workers", "usage", 2, FAKE_ACCOUNT.id, true],
							["2026-11-10", "D1", "usage", 0.25, FAKE_ACCOUNT.id, true],
							["2026-11-01", "Subscriptions", "purchase", 5, FAKE_ACCOUNT.id, false],
						],
					)
				}),
			)
		},
	)

	it.effect("reads a billing period that starts mid-month, whose days span two months", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare({
			anchorDay: 21,
			usage: [
				// Both days belong to the period that started on 21 September.
				usageRow("2026-10-20", "R2", "R2 Storage", 1),
				usageRow("2026-10-21", "R2", "R2 Storage", 2),
			],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				const pulled = yield* pull(ORG, connectionRef)
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [row.day, row.billedCost]),
					[
						["2026-10-20", 1],
						["2026-10-21", 2],
					],
				)
			}),
		)
	})

	it.effect("reads a long window in pieces under the range cap, each day once", () => {
		const testDb = createTestDb(trackedDbs)
		const window = { startDay: "2025-12-01", endDay: "2026-03-31" }
		const world = makeFakeCloudflare({
			usage: [
				usageRow("2025-12-01", "R2", "R2 Storage", 1),
				// The last day of the first piece and the first of the second.
				usageRow("2026-01-24", "R2", "R2 Storage", 2),
				usageRow("2026-01-25", "R2", "R2 Storage", 3),
				usageRow("2026-03-31", "R2", "R2 Storage", 4),
			],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				const pulled = yield* pull(ORG, connectionRef, window)
				// Three pieces of 55 days at most, each led by 31 days. The fake refuses a range over 90
				// days, as Cloudflare does.
				assert.deepStrictEqual(world.urls.slice(1, 4), [
					`${ACCOUNT_PATH}/billable-usage?from=2025-10-31&to=2026-01-25`,
					`${ACCOUNT_PATH}/billable-usage?from=2025-12-25&to=2026-03-21`,
					`${ACCOUNT_PATH}/billable-usage?from=2026-02-18&to=2026-04-01`,
				])
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [row.day, row.billedCost]),
					[
						["2025-12-01", 1],
						["2026-01-24", 2],
						["2026-01-25", 3],
						["2026-03-31", 4],
					],
				)
			}),
		)
	})

	it.effect("reads the oldest month it keeps, though the range it asks reaches past what is served", () => {
		const testDb = createTestDb(trackedDbs)
		// Cloudflare serves a year: the lead before the floor month asks for older days and gets none.
		const world = makeFakeCloudflare({
			oldestDay: "2025-11-11",
			anchorDay: 5,
			usage: [
				usageRow("2025-11-10", "R2", "R2 Storage", 9),
				// These days belong to the period that started on 5 November, before the oldest day.
				usageRow("2025-12-01", "R2", "R2 Storage", 1),
				usageRow("2025-12-04", "R2", "R2 Storage", 2),
				usageRow("2025-12-31", "R2", "R2 Storage", 3),
			],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				const pulled = yield* pull(ORG, connectionRef, {
					startDay: "2025-12-01",
					endDay: "2025-12-31",
				})
				assert.strictEqual(
					world.urls[1],
					`${ACCOUNT_PATH}/billable-usage?from=2025-10-31&to=2026-01-01`,
				)
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [row.day, row.billedCost]),
					[
						["2025-12-01", 1],
						["2025-12-04", 2],
						["2025-12-31", 3],
					],
				)
			}),
		)
	})

	it.effect(
		"fails a subscription listing longer than it reads, since part of the fees would under-count",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeCloudflare({
				subscriptionsPageSize: 1,
				subscriptions: Arr.makeBy(11, (index) => ({
					price: 5,
					frequency: "monthly",
					current_period_start: "2026-11-01T00:00:00Z",
					rate_plan: { public_name: `Plan ${index}` },
				})),
			})
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const connectionRef = yield* saveToken(testDb, world)
					assert.strictEqual(
						(yield* Effect.flip(pull(ORG, connectionRef))).reason,
						"invalid_response",
					)
				}),
			)
		},
	)

	it.effect("reads every page of the subscriptions", () => {
		const testDb = createTestDb(trackedDbs)
		const fee = (name: string) => ({
			price: 5,
			frequency: "monthly",
			current_period_start: "2026-11-01T00:00:00Z",
			rate_plan: { public_name: name },
		})
		const world = makeFakeCloudflare({
			subscriptionsPageSize: 2,
			subscriptions: [fee("Plan A"), fee("Plan B"), fee("Plan C")],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				const pulled = yield* pull(ORG, connectionRef)
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => row.usageType),
					["Plan A", "Plan B", "Plan C"],
				)
			}),
		)
	})

	it.effect("says what the sync should do about each way Cloudflare refuses", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				const reasons = yield* Effect.forEach([401, 403, 400, 429, 502], (status) =>
					Effect.gen(function* () {
						world.billingStatus = status
						return (yield* Effect.flip(pull(ORG, connectionRef))).reason
					}),
				)
				assert.deepStrictEqual(reasons, ["auth", "not_ready", "upstream", "rate_limited", "upstream"])
			}),
		)
	})

	it.effect("holds an account Cloudflare has no usage-based billing for, before reading any usage", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				world.covered = false
				const error = yield* Effect.flip(pull(ORG, connectionRef))
				assert.deepStrictEqual(reasonOf(error), ["not_ready", 0, "cloudflare"])
				assert.deepStrictEqual(world.urls, [`${ACCOUNT_PATH}/billable-usage/info`])
			}),
		)
	})

	it.effect("fails an answer it cannot read as invalid, with nothing to store", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				world.usage = "<html>maintenance</html>"
				assert.deepStrictEqual(reasonOf(yield* Effect.flip(pull(ORG, connectionRef))), [
					"invalid_response",
					0,
					"cloudflare",
				])
				// A row without its cost is not guessed at.
				world.usage =
					'{"result":[{"ServiceName":"R2 Storage","ChargePeriodStart":"2026-11-01T00:00:00Z"}]}'
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
			}),
		)
	})

	it.effect("is built on a deployment whose secret key is unusable, and fails only its own pulls", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare()
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				testDb.pglite.query(
					`INSERT INTO cost_connections
					   (id, org_id, provider, secret_ciphertext, secret_iv, secret_tag, account_id, account_label, created_at, updated_at, updated_by)
					 VALUES ('conn_a', 'org_cost', 'cloudflare', 'sealed', 'iv', 'tag', 'account_a', 'Example Account', now(), now(), 'user_cost')`,
				),
			)
			const error = yield* Effect.flip(pull(ORG, "conn_a"))
			assert.deepStrictEqual([error.reason, world.urls], ["auth", []])
		}).pipe(
			Effect.provide(
				Layer.effect(CloudflareCostProvider, CloudflareCostProvider.make).pipe(
					Layer.provide(fakeCloudflareDeps(testDb, world, "not-a-32-byte-key")),
				),
			),
		)
	})

	it.effect("never reads a token through another org's source, or a connection that is gone", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				assert.strictEqual((yield* Effect.flip(pull(OTHER_ORG, connectionRef))).reason, "auth")
				assert.strictEqual((yield* Effect.flip(pull(ORG, "no-such-connection"))).reason, "auth")
				assert.deepStrictEqual(world.urls, [])
			}),
		)
	})
})
