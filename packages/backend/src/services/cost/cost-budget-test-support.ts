// What the cost budget suites share: a database with the alert services over it, a warehouse
// that answers a budget's daily spend, and the org's cost source the reads name.
import type { OrgId } from "@maple/primitives"
import { compiledQueryOf, type CompiledQueryInput } from "@maple/query-engine/execution"
import { Array as Arr, Effect, Layer, String as Str } from "effect"
import { makeLayer, type TestOverrides } from "@maple/backend/services/alerts/alerts-service-test-support"
import { createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import {
	QueryEngineService,
	type QueryEngineServiceApi,
} from "@maple/backend/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { CostBudgetsService } from "./CostBudgetsService"
import { CostBudgetSource } from "./CostBudgetSource"

/** What `cost_daily` answers every budget with; a test changes it as its days go by. */
export interface Spend {
	days: ReadonlyArray<{ readonly day: string; readonly cost: number }>
}

const SOURCE_ID = "0190f2b3-0000-7000-8000-00000000000a"

/** The query engine as a spend read sees it: `cachedDirect` runs the compute. */
const uncachedQueryEngine: QueryEngineServiceApi = {
	execute: () => Effect.die("execute is not used by a budget's read"),
	evaluate: () => Effect.die("evaluate is not used by a budget's read"),
	evaluateSeries: () => Effect.die("evaluateSeries is not used by a budget's read"),
	cachedDirect: (_tenant, _route, _payload, effect) => effect,
}

/**
 * The cost statements the warehouse ran and the bodies the webhook endpoint was sent. `clock`
 * replaces the alert scheduler's clock, for a tick whose reads of it differ.
 */
export const budgetHarness = (
	trackedDbs: Array<TestDb>,
	spend: Spend,
	clock: Pick<TestOverrides, "now"> = {},
) => {
	const testDb = createTestDb(trackedDbs)
	const statements: Array<string> = []
	const bodies: Array<string> = []
	const fetchImpl: typeof fetch = async (_input, init) => {
		const body = init?.body
		bodies.push(
			body instanceof Uint8Array
				? new TextDecoder().decode(body)
				: typeof body === "string"
					? body
					: "",
		)
		return new Response("ok", { status: 200 })
	}
	const answer = (compiled: CompiledQueryInput<unknown>) => {
		const query = compiledQueryOf(compiled)
		if (!Str.includes("cost_daily")(query.sql)) return query.decodeRows([]).pipe(Effect.orDie)
		statements.push(Str.replace(/\s+/g, " ")(query.sql))
		return query
			.decodeRows(
				Arr.map(spend.days, (row) => ({
					date: row.day,
					key: "",
					other: 0,
					cost: row.cost,
					estimated: 0,
				})),
			)
			.pipe(Effect.orDie)
	}
	const warehouse = makeWarehouseServiceStub({
		// SAFETY: a budget's read hands the stub a plain compiled query, never a capability compile.
		compiledQuery: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) =>
			answer(compiled)) as never,
	})
	// The budgets service reads spend uncached; the evaluator inside `makeLayer` has the real cache.
	const source = Layer.effect(CostBudgetSource, CostBudgetSource.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				testDb.layer,
				Layer.succeed(WarehouseQueryService, warehouse),
				Layer.succeed(QueryEngineService, uncachedQueryEngine),
			),
		),
	)
	const budgets = Layer.effect(CostBudgetsService, CostBudgetsService.make).pipe(
		Layer.provide(Layer.mergeAll(source, testDb.layer)),
	)
	return {
		testDb,
		statements,
		bodies,
		layer: Layer.mergeAll(makeLayer(testDb, warehouse, { fetch: fetchImpl, ...clock }), budgets),
	}
}

/** The org's one cost source. A read names the org's sources, so no source reads no cost. */
export const connectCostSource = (testDb: TestDb, orgId: OrgId) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO cost_sources (id, org_id, provider, connection_ref, account_id, created_at, updated_at)
			 VALUES ($1, $2, 'aws', $1, '000000000000', now(), now())`,
			[SOURCE_ID, orgId],
		),
	)

/** A sync wrote the source: its stamp moves, and with it the key every cost read is cached under. */
export const syncCostSource = (testDb: TestDb, atMs: number) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			"UPDATE cost_sources SET updated_at = to_timestamp($2::float8 / 1000) WHERE id = $1",
			[SOURCE_ID, atMs],
		),
	)
