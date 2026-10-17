import { Effect } from "effect"
import { OrgId, UserId } from "@maple/domain/primitives"
import { latestSnapshotStatements } from "@maple/domain/generated/clickhouse-schema"
import type { QueryEngineBatchOutcome, QueryEngineExecuteRequest } from "@maple/query-engine"
import { makeWarehouseExecutor, WarehouseDriverError, type WarehouseSqlClient } from "@maple/query-engine/execution"
import { makeQueryEngineExecute } from "@maple/query-engine/runtime"
import { TELEMETRY_TABLES, type TelemetryRows } from "../fixtures/telemetry/rows.ts"
import { sharedChdb, type Chdb, type ParityChdbError } from "./chdb.ts"

/**
 * The fixture warehouse: the API's own lowering (`makeQueryEngineExecute`, which
 * `QueryEngineService.execute` wraps in caches) over the real `makeWarehouseExecutor`
 * (OrgId enforcement, settings, row decoding), with chDB as the driver.
 */

/** TTLs are relative to the host clock, so seeded rows at a frozen `now` would age out. */
const schemaStatements = latestSnapshotStatements.map((statement) => statement.replace(/\nTTL [^\n]*/g, ""))

const INSERT_CHUNK_ROWS = 5000

const insertRows = (chdb: Chdb, table: string, rows: ReadonlyArray<unknown>) =>
	Effect.forEach(
		Array.from({ length: Math.ceil(rows.length / INSERT_CHUNK_ROWS) }, (_, index) =>
			rows.slice(index * INSERT_CHUNK_ROWS, (index + 1) * INSERT_CHUNK_ROWS),
		),
		(chunk) =>
			chdb.run(`INSERT INTO ${table} FORMAT JSONEachRow\n${chunk.map((row) => JSON.stringify(row)).join("\n")}`),
		{ discard: true },
	)

export interface WarehouseSeed {
	/** The OrgId every row is stamped with; datasets sharing an org share the first seed. */
	readonly orgId: string
	readonly rows: TelemetryRows
}

/** chDB lives for the whole process, so each org is seeded once however many backends start. */
const seeded = new Map<string, Effect.Effect<void, ParityChdbError>>()

const once = (key: string, effect: Effect.Effect<void, ParityChdbError>) => {
	const existing = seeded.get(key)
	if (existing !== undefined) return existing
	const cached = Effect.runSync(Effect.cached(effect))
	seeded.set(key, cached)
	return cached
}

/** Creates the schema and seeds every org's rows; orgs are kept apart by OrgId, as in prd. */
export const seedWarehouse = (seeds: ReadonlyArray<WarehouseSeed>): Effect.Effect<Chdb, ParityChdbError> =>
	Effect.gen(function* () {
		const chdb = yield* sharedChdb
		yield* once("schema", Effect.forEach(schemaStatements, (statement) => chdb.run(statement), { discard: true }))
		yield* Effect.forEach(
			seeds,
			(seed) =>
				once(
					`org:${seed.orgId}`,
					Effect.forEach(TELEMETRY_TABLES, (table) => insertRows(chdb, table, seed.rows[table]), { discard: true }),
				),
			{ discard: true },
		)
		return chdb
	})

const chdbClient = (chdb: Chdb): WarehouseSqlClient => ({
	sql: (statement) =>
		chdb.rows(statement.text).pipe(
			Effect.map((data) => ({ data })),
			Effect.mapError(
				(error) => new WarehouseDriverError({ reason: "server", status: 500, message: error.message, cause: error }),
			),
		),
	insert: () =>
		Effect.fail(new WarehouseDriverError({ reason: "config", message: "the fixture warehouse is read-only" })),
})

export interface FixtureWarehouse {
	/** One execute-batch item, answered as the API answers it: a per-item success or failure outcome. */
	readonly execute: (orgId: OrgId, request: QueryEngineExecuteRequest) => Effect.Effect<QueryEngineBatchOutcome>
}

/**
 * `kind: "tinybird-gateway"` picks the managed dialect prd runs (static managed capabilities, no
 * `system.*` probes, Tinybird-restricted settings stripped); `createClient` routes it to chDB.
 */
export const makeFixtureWarehouse = (chdb: Chdb): FixtureWarehouse => {
	const executor = makeWarehouseExecutor({
		createClient: () => Effect.succeed(chdbClient(chdb)),
		resolveRoute: () =>
			Effect.succeed({
				source: "managed" as const,
				config: { kind: "tinybird-gateway" as const, url: "chdb://parity", username: "", password: "", database: "default" },
				clientCacheKey: "parity",
			}),
		coalesceCapabilityProbes: true,
	})
	const execute = makeQueryEngineExecute(executor)
	const userId = UserId.make("user_parity_warehouse")
	return {
		execute: (orgId, request) =>
			execute({ orgId, userId, authMode: "self_hosted" }, request).pipe(
				Effect.map((response): QueryEngineBatchOutcome => ({ outcome: "success", result: response.result })),
				Effect.catch((error) => Effect.succeed<QueryEngineBatchOutcome>({ outcome: "failure", error: error.error })),
			),
	}
}

export const parityOrgId = (raw: string): OrgId => OrgId.make(raw)
