import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import type { MigrationModuleContext } from "../src/server/local-store-migration-module"
import { localSchemaSnapshot } from "../src/server/schema-snapshots"
import { describeWithChdb } from "./libchdb-test-support"
import { migrationStep, openStore } from "./local-store-step-test-support"

const DAY_MS = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")
const SPAN_COLUMNS =
	"OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanKind, ServiceName, Duration, StatusCode"
/** A client span in `web` and its server child in `api`: one service-map edge per trace. */
const callPair = (atMs: number, n: number) =>
	`('local', '${iso(atMs)}', 'trace-${n}', 'client-${n}', '', 'Client', 'web', ${1000 + n}, 'Ok'), ` +
	`('local', '${iso(atMs)}', 'trace-${n}', 'server-${n}', 'client-${n}', 'Server', 'api', ${900 + n}, 'Ok')`

const decodeSnapshot = decodeJsonEachRow(
	Schema.Struct({
		spans: Schema.String,
		children: Schema.String,
		durationSum: Schema.String,
		edges: Schema.String,
	}),
)
/** Both span tables, plus the parent ⋈ child join the service map reads off them. */
const snapshot = (db: Chdb) =>
	decodeSnapshot(
		db.query(`SELECT
			toString((SELECT count() FROM service_map_spans)) AS spans,
			toString((SELECT count() FROM service_map_children)) AS children,
			toString((SELECT sum(Duration) FROM service_map_children)) AS durationSum,
			toString((SELECT count() FROM service_map_spans p INNER JOIN service_map_children c ON p.TraceId = c.TraceId AND p.SpanId = c.ParentSpanId WHERE p.SpanKind = 'Client')) AS edges`),
	)[0]

const decodeTables = decodeJsonEachRow(
	Schema.Struct({ name: Schema.String, sortingKey: Schema.String, definition: Schema.String }),
)
const spanTables = (db: Chdb) =>
	decodeTables(
		db.query(
			"SELECT name, sorting_key AS sortingKey, create_table_query AS definition FROM system.tables WHERE database = 'default' AND name IN ('service_map_spans', 'service_map_children') ORDER BY name",
		),
	)

const ttlOf = (table: { readonly definition: string }) =>
	table.definition.match(/\bTTL\s+(.+?)(?=\bSETTINGS\b|$)/s)?.[1]

describeWithChdb("v39 -> v40 service-map span tables re-sort", () => {
	const STEP_ID = "local-0039-to-0040-service-map-spans-trace-key"
	let migration: ReturnType<typeof migrationStep>["migration"]
	let root = ""
	let sourceDataDir = ""
	let targetDataDir = ""
	let context: MigrationModuleContext
	const nowMs = Date.now()

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "maple-service-map-rekey-"))
		sourceDataDir = join(root, "source", "data")
		targetDataDir = join(root, "target", "data")
		// Spans land through `traces` and its views, as ingest writes them.
		const ages = [0, 0.1, 1, 2, 5]
		const db = Chdb.open({
			dataDir: sourceDataDir,
			schemaSql: localSchemaSnapshot(39).sql,
		})
		db.exec(
			`INSERT INTO traces (${SPAN_COLUMNS}) VALUES ${ages.map((age, n) => callPair(nowMs - age * DAY_MS, n)).join(", ")}`,
		)
		db.close()
		;({ migration, context } = migrationStep(STEP_ID, sourceDataDir, targetDataDir, nowMs))
	})

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true })
	})

	test("re-sorts both tables without losing a row or an edge, and a re-run converges", async () => {
		const before = await openStore(sourceDataDir, snapshot)
		const ttlsBefore = await openStore(sourceDataDir, (db) => spanTables(db).map(ttlOf))
		expect(ttlsBefore.every((ttl) => ttl !== undefined)).toBe(true)
		expect(before).toEqual({ spans: "10", children: "5", durationSum: "4510", edges: "5" })

		const state = await migration.preflight(context)
		await migration.prepareTarget(context, state)
		const progress = await migration.apply(context, state, undefined)
		await migration.verify(context, state, progress)
		// A crash after the swap re-runs apply on the already re-sorted target.
		const resumed = await migration.apply(context, state, progress)
		await migration.verify(context, state, resumed)
		expect(resumed).toEqual({ rekeyedServiceMapSpans: "10", rekeyedServiceMapChildren: "5" })

		const after = await openStore(targetDataDir, (db) => ({
			snapshot: snapshot(db),
			tables: spanTables(db),
		}))
		expect(after.snapshot).toEqual(before)
		expect(after.tables.map((table) => [table.name, table.sortingKey])).toEqual([
			["service_map_children", "OrgId, toStartOfFiveMinutes(Timestamp), TraceId, ParentSpanId"],
			["service_map_spans", "OrgId, toStartOfFiveMinutes(Timestamp), TraceId, SpanId"],
		])
		expect(after.tables.map(ttlOf)).toEqual(ttlsBefore)
	})

	test("the views still fill both tables for spans ingested after the swap", async () => {
		const [before, after] = await openStore(
			targetDataDir,
			(db) => {
				const prior = snapshot(db)
				db.exec(`INSERT INTO traces (${SPAN_COLUMNS}) VALUES ${callPair(nowMs, 99)}`)
				return [prior, snapshot(db)] as const
			},
			{ schemaSql: localSchemaSnapshot(40).sql, bootstrapSchema: false },
		)
		expect(Number(after?.spans)).toBe(Number(before?.spans) + 2)
		expect(Number(after?.children)).toBe(Number(before?.children) + 1)
		expect(Number(after?.edges)).toBe(Number(before?.edges) + 1)
	})
})
