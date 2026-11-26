import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import type { MigrationModuleContext } from "@maple/local-server/local-store-migration-module"
import { localSchemaSnapshot } from "@maple/local-server/local-schema-history"
import { describeWithChdb } from "./libchdb-test-support"
import { migrationStep, openStore } from "./local-store-step-test-support"

const iso = (ms: number) => Str.replace("Z", "")(Str.replace("T", " ")(new Date(ms).toISOString()))

const decodeColumns = decodeJsonEachRow(
	Schema.Struct({
		name: Schema.String,
		type: Schema.String,
		defaultKind: Schema.String,
		defaultExpression: Schema.String,
	}),
)
const decodeKeys = decodeJsonEachRow(Schema.Struct({ sortingKey: Schema.String, primaryKey: Schema.String }))
const decodeRows = decodeJsonEachRow(Schema.Struct({ traceId: Schema.String, days: Schema.String }))

/** trace_index's columns, defaults, sorting and primary key, as system tables report them. */
const traceIndexDefinition = (db: Chdb) => ({
	columns: decodeColumns(
		db.query(
			"SELECT name, type, default_kind AS defaultKind, default_expression AS defaultExpression FROM system.columns WHERE database = 'default' AND table = 'trace_index' ORDER BY position",
		),
	),
	keys: decodeKeys(
		db.query(
			"SELECT sorting_key AS sortingKey, primary_key AS primaryKey FROM system.tables WHERE database = 'default' AND name = 'trace_index'",
		),
	)[0],
})

const storedRows = (db: Chdb) =>
	decodeRows(
		db.query(
			"SELECT TraceId AS traceId, toString(RetentionDays) AS days FROM trace_index WHERE OrgId = 'local' ORDER BY traceId",
		),
	)

describeWithChdb("v67 -> v68 trace_index sorts by RetentionDays", () => {
	const STEP_ID = "local-0067-to-0068-retention-storage"
	let migration: ReturnType<typeof migrationStep>["migration"]
	let root = ""
	let sourceDataDir = ""
	let targetDataDir = ""
	let freshDataDir = ""
	let context: MigrationModuleContext
	const nowMs = Date.now()
	const bucket = iso(Math.floor((nowMs - 3_600_000) / 3_600_000) * 3_600_000)

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "maple-trace-index-retention-"))
		sourceDataDir = join(root, "source", "data")
		targetDataDir = join(root, "target", "data")
		freshDataDir = join(root, "fresh", "data")
		const db = Chdb.open({ dataDir: sourceDataDir, schemaSql: localSchemaSnapshot(67).sql })
		db.exec(
			`INSERT INTO trace_index (OrgId, TraceId, ServiceName, Bucket, MinTimestamp, MaxTimestamp) VALUES ('local', 'trace-a', 'api', '${bucket}', '${bucket}', '${bucket}'), ('local', 'trace-b', 'api', '${bucket}', '${bucket}', '${bucket}'), ('local', 'trace-c', 'worker', '${bucket}', '${bucket}', '${bucket}')`,
		)
		db.close()
		;({ migration, context } = migrationStep(STEP_ID, sourceDataDir, targetDataDir, nowMs))
	}, 30_000)

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true })
	})

	test("adds the column to the sorting key, rows read 30, and a re-run converges", async () => {
		const state = await migration.preflight(context)
		await migration.prepareTarget(context, state)
		const progress = await migration.apply(context, state, undefined)
		await migration.verify(context, state, progress)
		// A crash after the ALTERs re-runs apply on the already migrated target.
		const resumed = await migration.apply(context, state, progress)
		await migration.verify(context, state, resumed)

		const migrated = await openStore(
			targetDataDir,
			(db) => {
				const definition = traceIndexDefinition(db)
				const before = storedRows(db)
				db.exec("OPTIMIZE TABLE trace_index FINAL")
				return { definition, before, after: storedRows(db) }
			},
			{ schemaSql: localSchemaSnapshot(68).sql, bootstrapSchema: false },
		)
		const fresh = await openStore(freshDataDir, traceIndexDefinition, {
			schemaSql: localSchemaSnapshot(68).sql,
			bootstrapSchema: true,
		})

		expect(migrated.definition.keys).toEqual({
			sortingKey: "OrgId, TraceId, ServiceName, Bucket, RetentionDays",
			primaryKey: "OrgId, TraceId, ServiceName, Bucket",
		})
		expect(
			Option.getOrUndefined(
				Arr.findFirst(migrated.definition.columns, (column) => column.name === "RetentionDays"),
			),
		).toEqual({
			name: "RetentionDays",
			type: "UInt16",
			defaultKind: "DEFAULT",
			defaultExpression: "30",
		})
		const expected = [
			{ traceId: "trace-a", days: "30" },
			{ traceId: "trace-b", days: "30" },
			{ traceId: "trace-c", days: "30" },
		]
		expect(migrated.before).toEqual(expected)
		expect(migrated.after).toEqual(expected)
		expect(migrated.definition).toEqual(fresh)
	})
})
