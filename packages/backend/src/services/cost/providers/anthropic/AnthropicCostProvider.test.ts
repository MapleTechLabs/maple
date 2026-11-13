import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { AnthropicCostConnectionService } from "../../AnthropicCostConnectionService"
import type { CostProviderError } from "../../CostProvider"
import { addDays, daysFrom } from "../../sync-plan"
import { AnthropicCostProvider } from "./AnthropicCostProvider"
import {
	costBucket,
	costResult,
	FAKE_ORGANIZATION,
	type FakeAnthropic,
	fakeAnthropicDeps,
	makeFakeAnthropic,
} from "./fake-anthropic"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_cost")
const KEY = "sk-ant-admin01-0123456789abcdefghijABCDEFGHIJ0123456789-AbCdEfAA"
/** 40 days: two pages of the report. */
const WINDOW = { startDay: "2026-10-02", endDay: "2026-11-10" }
/** The pull runs the morning after the window's last day. */
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))

const run = <A, E>(
	testDb: TestDb,
	world: FakeAnthropic,
	effect: Effect.Effect<A, E, AnthropicCostProvider | AnthropicCostConnectionService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(AnthropicCostProvider, AnthropicCostProvider.make),
				Layer.effect(AnthropicCostConnectionService, AnthropicCostConnectionService.make),
			).pipe(Layer.provide(fakeAnthropicDeps(testDb, world))),
		),
	)

/** Saves `KEY` for `ORG` and answers the connection's id, with the fake's call log emptied. */
const saveKey = (testDb: TestDb, world: FakeAnthropic) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		yield* AnthropicCostConnectionService.use((service) => service.set(ORG, USER, KEY))
		const row = yield* Effect.promise(() =>
			queryFirstRow<{ id: string }>(testDb, "SELECT id FROM cost_connections"),
		)
		world.urls.length = 0
		world.headers.length = 0
		return row?.id ?? ""
	})

const pull = (orgId: OrgId, connectionRef: string, window = WINDOW) =>
	AnthropicCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

const reasonOf = (error: CostProviderError) => [error.reason, error.requests, error.provider]

/** The cursor each request of the log asked with, `null` for the first page. */
const pagesAsked = (world: FakeAnthropic) =>
	Arr.map(world.urls, (url) => new URL(`https://api.anthropic.com${url}`).searchParams.get("page"))

/** A bucket for every day of the window, as the real report has, with spend on a few. */
const everyDay = (spend: ReadonlyMap<string, string>) =>
	Arr.map(daysFrom(addDays(WINDOW.startDay, -3), 46), (day) => {
		const amount = spend.get(day)
		return costBucket(day, amount === undefined ? [] : [costResult(amount)])
	})

describe("AnthropicCostProvider", () => {
	it.effect("follows the report's pages and keeps the window's days, in dollars", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic({
			buckets: everyDay(
				new Map([
					["2026-10-01", "999"],
					["2026-10-02", "150"],
					["2026-11-02", "250"],
					["2026-11-10", "12.5"],
				]),
			),
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				const pulled = yield* pull(ORG, connectionRef)
				// 40 days at 31 a page: the second page is asked for with the first one's cursor.
				assert.deepStrictEqual(pagesAsked(world), [null, "page_31"])
				assert.deepStrictEqual(world.headers, Arr.replicate([KEY, "2023-06-01"], 2))
				assert.strictEqual(pulled.requests, 0)
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [
						row.day,
						row.cloudService,
						row.billedCost,
						row.accountId,
						row.estimated,
					]),
					[
						["2026-10-02", "anthropic/claude-opus-5-5", 1.5, FAKE_ORGANIZATION.id, false],
						["2026-11-02", "anthropic/claude-opus-5-5", 2.5, FAKE_ORGANIZATION.id, false],
						["2026-11-10", "anthropic/claude-opus-5-5", 0.125, FAKE_ORGANIZATION.id, true],
					],
				)
			}),
		)
	})

	it.effect("fails as too large rather than read a report that never ends", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic({ buckets: everyDay(new Map()), endless: true })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				const error = yield* Effect.flip(pull(ORG, connectionRef))
				assert.deepStrictEqual(reasonOf(error), ["too_large", 0, "anthropic"])
				assert.strictEqual(world.urls.length, 60)
			}),
		)
	})

	it.effect("asks for a new key when Anthropic rejects or narrows the saved one", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				world.costStatus = 401
				const rejected = yield* Effect.flip(pull(ORG, connectionRef))
				assert.deepStrictEqual(reasonOf(rejected), ["auth", 0, "anthropic"])
				assert.strictEqual(
					rejected.message,
					"Anthropic rejected the saved key. Replace the key to resume the sync.",
				)
				world.costStatus = 403
				const narrowed = yield* Effect.flip(pull(ORG, connectionRef))
				assert.deepStrictEqual(reasonOf(narrowed), ["not_ready", 0, "anthropic"])
				world.costStatus = 429
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "rate_limited")
				world.costStatus = 503
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "upstream")
			}),
		)
	})

	it.effect("fails an unreadable answer or amount instead of storing a partial day", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				world.buckets = "<html>maintenance</html>"
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
				world.buckets = [costBucket("2026-11-03", [costResult("100"), costResult("n/a")])]
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
			}),
		)
	})

	it.effect("reads nothing for a source with no key, or another org's", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAnthropic()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveKey(testDb, world)
				const foreign = yield* Effect.flip(pull(OTHER_ORG, connectionRef))
				assert.deepStrictEqual(reasonOf(foreign), ["auth", 0, "anthropic"])
				assert.strictEqual(foreign.message, "No Anthropic key is saved for this source.")
				assert.deepStrictEqual(world.urls, [])
			}),
		)
	})
})
