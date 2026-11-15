import { afterEach, assert, describe, it } from "@effect/vitest"
import type { StoredCostBudget } from "@maple/domain/cost-budget"
import type { TenantContext } from "@maple/domain/http"
import { compiledQueryOf, type CompiledQueryInput } from "@maple/query-engine/execution"
import { Array as Arr, Effect, Layer, Schema, String as Str } from "effect"
import { asOrgId, asUserId } from "@maple/backend/services/alerts/alerts-service-test-support"
import {
	QueryEngineService,
	type QueryEngineServiceApi,
} from "@maple/backend/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { CostBudgetSource } from "./CostBudgetSource"
import { connectCostSource, syncCostSource, type Spend } from "./cost-budget-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = asOrgId("org_cost_budget_source")
const tenant: TenantContext = {
	orgId,
	userId: asUserId("user_cost_budget_source"),
	roles: [],
	authMode: "self_hosted",
}

const NOW = Date.parse("2026-11-16T10:00:00Z")
const HOUR = 3_600_000

const budget: StoredCostBudget = {
	amount: 1000,
	currency: "USD",
	period: "month",
	metric: "billed",
	filters: {},
	forecastSeverities: [],
}

const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/**
 * The source over a warehouse that answers `spend`, behind a query engine that keeps every
 * answer by its key, as the cache does inside its time to live.
 */
const harness = (spend: Spend) => {
	const testDb = createTestDb(trackedDbs)
	const answers = new Map<string, unknown>()
	const queryEngine: QueryEngineServiceApi = {
		execute: () => Effect.die("execute is not used by a budget's read"),
		evaluate: () => Effect.die("evaluate is not used by a budget's read"),
		evaluateSeries: () => Effect.die("evaluateSeries is not used by a budget's read"),
		cachedDirect: (_tenant, route, payload, effect) => {
			const key = `${route} ${encodeKey(payload)}`
			return answers.has(key)
				? // SAFETY: the answer under a key is the one this effect produced for it.
					Effect.succeed(answers.get(key) as never)
				: Effect.tap(effect, (answer) => Effect.sync(() => answers.set(key, answer)))
		},
	}
	const warehouse = makeWarehouseServiceStub({
		// SAFETY: a budget's read hands the stub a plain compiled query, never a capability compile.
		compiledQuery: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) => {
			const query = compiledQueryOf(compiled)
			return query
				.decodeRows(
					Str.includes("cost_daily")(query.sql)
						? Arr.map(spend.days, (row) => ({
								date: row.day,
								key: "",
								other: 0,
								cost: row.cost,
								estimated: 0,
							}))
						: [],
				)
				.pipe(Effect.orDie)
		}) as never,
	})
	const layer = Layer.effect(CostBudgetSource, CostBudgetSource.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				testDb.layer,
				Layer.succeed(WarehouseQueryService, warehouse),
				Layer.succeed(QueryEngineService, queryEngine),
			),
		),
	)
	return { testDb, layer }
}

const spentAt = (nowMs: number) =>
	Effect.gen(function* () {
		const source = yield* CostBudgetSource
		const [standing] = yield* source.progress(tenant, [budget], nowMs)
		return standing?.[1].spent
	})

describe("CostBudgetSource", () => {
	// An hourly check asks for the same window all day, and that answer is cached. Spend only
	// changes when a sync writes, and the sync's stamp on the source is part of the key.
	it.effect("reads a cached answer until a sync writes, then reads the warehouse again", () => {
		const spend: Spend = { days: [{ day: "2026-11-15", cost: 400 }] }
		const { layer, testDb } = harness(spend)
		return Effect.gen(function* () {
			yield* connectCostSource(testDb, orgId)
			yield* syncCostSource(testDb, NOW - HOUR)
			assert.strictEqual(yield* spentAt(NOW), 400)

			// The warehouse now holds more, but nothing says a sync wrote it: the answer is the kept one.
			spend.days = [{ day: "2026-11-15", cost: 1100 }]
			assert.strictEqual(yield* spentAt(NOW + HOUR), 400)

			yield* syncCostSource(testDb, NOW + HOUR)
			assert.strictEqual(yield* spentAt(NOW + 2 * HOUR), 1100)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads again when the day turns, without a sync", () => {
		const spend: Spend = { days: [{ day: "2026-11-15", cost: 400 }] }
		const { layer, testDb } = harness(spend)
		return Effect.gen(function* () {
			yield* connectCostSource(testDb, orgId)
			assert.strictEqual(yield* spentAt(NOW), 400)

			spend.days = [{ day: "2026-11-15", cost: 450 }]
			assert.strictEqual(yield* spentAt(NOW + 24 * HOUR), 450)
		}).pipe(Effect.provide(layer))
	})

	it.effect("stands at zero without asking the warehouse when the org has no cost source", () => {
		const { layer } = harness({ days: [{ day: "2026-11-15", cost: 400 }] })
		return Effect.gen(function* () {
			assert.strictEqual(yield* spentAt(NOW), 0)
		}).pipe(Effect.provide(layer))
	})
})
