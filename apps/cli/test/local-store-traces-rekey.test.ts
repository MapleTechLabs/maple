import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { Chdb, configureRawTelemetryRetentionDays } from "../src/server/chdb"
import { decodeJsonEachRow } from "../src/server/chdb-rows"
import type { MigrationDbOptions, MigrationModuleContext } from "../src/server/local-store-migration-module"
import { localStoreMigrations } from "../src/server/local-store-migrations"
import { localSchemaSnapshot } from "../src/server/schema-identity"
import { describeWithChdb } from "./libchdb-test-support"

const DAY_MS = 86_400_000
const RETENTION_DAYS = 120
const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")
const SPAN_COLUMNS =
	"OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SpanAttributes"
const span = (atMs: number, n: number) =>
	`('local', '${iso(atMs)}', 'trace-${n % 3}', 'span-${n}', '', 'GET /${n % 2}', 'Server', 'api', ${1000 + n}, 'Ok', map('n', '${n}'))`

const decodeSnapshot = decodeJsonEachRow(
	Schema.Struct({
		traces: Schema.String,
		durationSum: Schema.String,
		traceIndex: Schema.String,
		traceList: Schema.String,
		usage: Schema.String,
		aggregates: Schema.String,
	}),
)
/**
 * Raw spans plus rollups fed by views on `traces`; a view re-firing on the copy doubles them.
 * The 30-day rollups are windowed so a background TTL merge of the 60-day span cannot move them.
 */
const snapshot = (db: Chdb) =>
	decodeSnapshot(
		db.query(`SELECT
			toString((SELECT count() FROM traces)) AS traces,
			toString((SELECT sum(Duration) FROM traces)) AS durationSum,
			toString((SELECT count() FROM trace_index WHERE Bucket >= now() - INTERVAL 20 DAY)) AS traceIndex,
			toString((SELECT count() FROM trace_list_mv WHERE Timestamp >= now() - INTERVAL 20 DAY)) AS traceList,
			toString((SELECT sum(TraceCount) FROM service_usage)) AS usage,
			toString((SELECT sum(WeightedCount) FROM traces_aggregates_hourly)) AS aggregates`),
	)[0]

const decodeTable = decodeJsonEachRow(
	Schema.Struct({ sortingKey: Schema.String, definition: Schema.String, indexes: Schema.String }),
)
const tracesTable = (db: Chdb) =>
	decodeTable(
		db.query(
			"SELECT sorting_key AS sortingKey, create_table_query AS definition, (SELECT arrayStringConcat(groupArray(name), ',') FROM system.data_skipping_indices WHERE database = 'default' AND table = 'traces') AS indexes FROM system.tables WHERE database = 'default' AND name = 'traces'",
		),
	)[0]

const open = async <A>(
	dataDir: string,
	fn: (db: Chdb) => A | Promise<A>,
	options: MigrationDbOptions = {},
) => {
	const db = Chdb.open({
		dataDir,
		schemaSql: options.schemaSql ?? "",
		bootstrapSchema: options.bootstrapSchema ?? false,
	})
	try {
		return await fn(db)
	} finally {
		db.close()
	}
}

describeWithChdb("v33 -> v34 traces re-sort", () => {
	const [migration] = localStoreMigrations.filter(
		(candidate) => candidate.id === "local-0033-to-0034-traces-trace-key",
	)
	let root = ""
	let sourceDataDir = ""
	let targetDataDir = ""
	let context: MigrationModuleContext
	const nowMs = Date.now()

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "maple-traces-rekey-"))
		sourceDataDir = join(root, "source", "data")
		targetDataDir = join(root, "target", "data")
		await configureRawTelemetryRetentionDays(sourceDataDir, RETENTION_DAYS)
		const v33 = localSchemaSnapshot(33).sql
		// One span is 60 days old: only the store's raised TTL, not the bundled 30 days, keeps it.
		const ages = [0, 0.1, 1, 2, 5, 60]
		const db = Chdb.open({
			dataDir: sourceDataDir,
			schemaSql: v33,
			rawTelemetryRetentionDays: RETENTION_DAYS,
		})
		db.exec(
			`INSERT INTO traces (${SPAN_COLUMNS}) VALUES ${ages.map((age, n) => span(nowMs - age * DAY_MS, n)).join(", ")}`,
		)
		db.close()
		context = {
			dataDir: sourceDataDir,
			sourceDataDir,
			targetDataDir,
			source: migration!.from,
			target: migration!.to,
			cutoffAt: new Date(nowMs).toISOString(),
			step: {
				id: migration!.id,
				moduleVersion: 1,
				from: migration!.from,
				to: migration!.to,
				status: "running",
			},
			openSource: (fn, options) => open(sourceDataDir, fn, options),
			openTarget: (fn, options) => open(targetDataDir, fn, options),
			closeStores: async () => undefined,
			ensureCapacity: async () => undefined,
			saveStep: async () => undefined,
		}
	})

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true })
	})

	test("re-sorts traces without re-firing a view, and a re-run converges", async () => {
		const before = await open(sourceDataDir, snapshot)
		expect(before?.traces).toBe("6")

		const state = await migration!.preflight(context)
		await migration!.prepareTarget(context, state)
		const progress = await migration!.apply(context, state, undefined)
		await migration!.verify(context, state, progress)
		// A crash after the swap re-runs apply on the already re-sorted target.
		const resumed = await migration!.apply(context, state, progress)
		await migration!.verify(context, state, resumed)
		expect(resumed).toEqual({ rekeyedTraces: "6" })

		const after = await open(targetDataDir, (db) => ({ snapshot: snapshot(db), table: tracesTable(db) }))
		expect(after.snapshot).toEqual(before)
		expect(after.table?.sortingKey).toBe("OrgId, ServiceName, toStartOfFiveMinutes(Timestamp), TraceId")
		expect(after.table?.indexes.split(",")).toContain("idx_span_name")
		expect(after.table?.definition).toContain(`toIntervalDay(${RETENTION_DAYS})`)
	})

	test("views on traces still fire for spans ingested after the swap", async () => {
		const [before, after] = await open(
			targetDataDir,
			(db) => {
				const prior = snapshot(db)
				db.exec(`INSERT INTO traces (${SPAN_COLUMNS}) VALUES ${span(nowMs, 99)}`)
				return [prior, snapshot(db)] as const
			},
			{ schemaSql: localSchemaSnapshot(34).sql, bootstrapSchema: false },
		)
		expect(Number(after?.traces)).toBe(Number(before?.traces) + 1)
		expect(Number(after?.usage)).toBe(Number(before?.usage) + 1)
		expect(Number(after?.traceIndex)).toBeGreaterThan(Number(before?.traceIndex))
	})
})
