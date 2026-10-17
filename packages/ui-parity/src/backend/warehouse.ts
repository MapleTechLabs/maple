import { Effect } from "effect"
import { OrgId, UserId } from "@maple/domain/primitives"
import { latestSnapshotStatements } from "@maple/domain/generated/clickhouse-schema"
import { CH, parseWarehouseDateTime, type QueryEngineBatchOutcome, type QueryEngineExecuteRequest } from "@maple/query-engine"
import {
	makeWarehouseExecutor,
	WarehouseDriverError,
	type ExecutionTenant,
	type WarehouseQueryServiceApi,
	type WarehouseSqlClient,
} from "@maple/query-engine/execution"
import { makeQueryEngineExecute } from "@maple/query-engine/runtime"
import { TELEMETRY_TABLES, type TelemetryRows } from "../fixtures/telemetry/rows.ts"
import { ParityChdbError, sharedChdb, type Chdb } from "./chdb.ts"

/**
 * The fixture warehouse: the API's own lowering (`makeQueryEngineExecute`, which
 * `QueryEngineService.execute` wraps in caches) over the real `makeWarehouseExecutor`
 * (OrgId enforcement, settings, row decoding), with chDB as the driver.
 */

/** TTLs are relative to the host clock, so seeded rows at a frozen `now` would age out. */
const schemaStatements = latestSnapshotStatements.map((statement) => statement.replace(/\nTTL [^\n]*/g, ""))

const INSERT_CHUNK_ROWS = 5000

/** Column lists of the CLI's seal INSERTs (apps/cli/src/server/service-map-rollup.ts). */
const EDGE_COLUMNS =
	"OrgId, Hour, SourceService, TargetService, DeploymentEnv, CallCount, ErrorCount, DurationSumMs, MaxDurationMs, SampledSpanCount, UnsampledSpanCount, SampleRateSum"
const RESOLUTION_COLUMNS = "OrgId, Hour, SourceService, ParentServerAddress, ResolvedTargetService, DeploymentEnv"

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
	/** The dataset's frozen clock: every hour before it is sealed into the service map rollup. */
	readonly now: string
}

const SEAL_HOURS = 24

/**
 * `ServiceMapRollupService` (and the CLI's local rollup) seal each completed hour of
 * `service_map_edges_hourly` from raw spans; no MV fills it, so the seed runs the same seal.
 */
const sealServiceMap = (chdb: Chdb, orgId: OrgId, nowMs: number) => {
	const currentHourMs = Math.floor(nowMs / CH.SERVICE_MAP_ROLLUP_HOUR_MS) * CH.SERVICE_MAP_ROLLUP_HOUR_MS
	const hours = Array.from({ length: SEAL_HOURS }, (_, index) => currentHourMs - (SEAL_HOURS - index) * CH.SERVICE_MAP_ROLLUP_HOUR_MS)
	const body = (compiled: Effect.Effect<{ readonly sql: string }, CH.QueryBuilderError>) =>
		compiled.pipe(
			Effect.map((query) => query.sql.replace(/\s+FORMAT\s+\w+\s*$/, "")),
			Effect.mapError((error) => new ParityChdbError({ message: `service map seal: ${error.message}` })),
		)
	return Effect.forEach(
		hours,
		(hourMs) =>
			Effect.gen(function* () {
				const params = CH.serviceMapRollupHourParams(orgId, hourMs)
				const resolutions = yield* body(CH.serviceMapResolutionsRollupSQL(params))
				const edges = yield* body(CH.serviceMapEdgesRollupSQL(params))
				yield* chdb.run(`INSERT INTO service_address_resolutions_hourly (${RESOLUTION_COLUMNS}) SELECT ${RESOLUTION_COLUMNS} FROM (${resolutions})`)
				yield* chdb.run(`INSERT INTO service_map_edges_hourly_ingest (${EDGE_COLUMNS}) SELECT ${EDGE_COLUMNS} FROM (${edges})`)
			}),
		{ discard: true },
	)
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
		// Background merges fold rollup states in a timing-dependent order (t-digest quantiles drift
		// by ~0.1 ms run to run), so parts stay exactly as the seed inserted them.
		yield* once(
			"schema",
			Effect.forEach([...schemaStatements, "SYSTEM STOP MERGES"], (statement) => chdb.run(statement), { discard: true }),
		)
		yield* Effect.forEach(
			seeds,
			(seed) =>
				once(
					`org:${seed.orgId}`,
					Effect.forEach(TELEMETRY_TABLES, (table) => insertRows(chdb, table, seed.rows[table]), { discard: true }).pipe(
						Effect.andThen(sealServiceMap(chdb, parityOrgId(seed.orgId), parseWarehouseDateTime(seed.now))),
					),
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
	/** `QueryEngineService.execute` without its caches, for handlers that embed one result. */
	readonly executeQuery: ReturnType<typeof makeQueryEngineExecute<ExecutionTenant>>
	/** The `WarehouseQueryService` the API's dedicated handlers run their registry queries on. */
	readonly executor: WarehouseQueryServiceApi
	readonly tenantOf: (orgId: OrgId) => ExecutionTenant
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
	const executeQuery = makeQueryEngineExecute<ExecutionTenant>(executor)
	const userId = UserId.make("user_parity_warehouse")
	const tenantOf = (orgId: OrgId): ExecutionTenant => ({ orgId, userId, authMode: "self_hosted" })
	return {
		executeQuery,
		executor,
		tenantOf,
		execute: (orgId, request) =>
			executeQuery(tenantOf(orgId), request).pipe(
				Effect.map((response): QueryEngineBatchOutcome => ({ outcome: "success", result: response.result })),
				Effect.catch((error) => Effect.succeed<QueryEngineBatchOutcome>({ outcome: "failure", error: error.error })),
			),
	}
}

export const parityOrgId = (raw: string): OrgId => OrgId.make(raw)
