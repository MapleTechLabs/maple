import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Option, Predicate, Schema, String as Str, pipe } from "effect"
import {
	expandMigrationToSteps,
	isDropUnkeyedColumn,
	isRepairZeroKeyColumn,
	migrations,
} from "@maple/domain/clickhouse"
import { latestSnapshotStatements } from "@maple/domain/generated/clickhouse-schema"
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { addSortingColumn, stepStatements } from "@maple/local-server/local-store-migrations/step-executor"
import { describeWithChdb } from "./libchdb-test-support"

const TABLES = ["trace_index", "trace_facets_hourly"] as const
const retentionStorage = Arr.findFirst(migrations, (migration) => migration.version === 76).pipe(
	Option.getOrThrow,
)

const snapshotTable = (name: string): string =>
	Arr.findFirst(latestSnapshotStatements, (stmt) =>
		Str.startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`)(stmt),
	).pipe(Option.getOrThrow)

/** The table as a v75 cluster holds it: no RetentionDays, the key without it. */
const v75Table = (name: string): string =>
	pipe(
		snapshotTable(name),
		Str.replace(",\n    RetentionDays UInt16 DEFAULT 30", ""),
		Str.replace(/\nPRIMARY KEY \([^)]*\)/, ""),
		Str.replace(", RetentionDays)", ")"),
		Str.replace("toIntervalDay(least(RetentionDays, 30))", "INTERVAL 30 DAY"),
	)

/** 0076's statements for the two tables whose sorting key gains the column. */
const sortingKeyPart = {
	...retentionStorage,
	statements: Arr.filter(
		retentionStorage.statements,
		(stmt) =>
			isDropUnkeyedColumn(stmt) ||
			isRepairZeroKeyColumn(stmt) ||
			(Predicate.isString(stmt) &&
				Arr.some(
					TABLES,
					(table) =>
						Str.startsWith(`ALTER TABLE ${table} `)(stmt) ||
						Str.endsWith(` MERGES ${table}`)(stmt),
				)),
	),
}

const decodeKeyedColumn = decodeJsonEachRow(
	Schema.Struct({
		sortingKey: Schema.String,
		defaultExpression: Schema.String,
		days: Schema.String,
		rows: Schema.String,
	}),
)

const keyedColumn = (db: Chdb, table: string) =>
	decodeKeyedColumn(
		db.query(
			`SELECT (SELECT sorting_key FROM system.tables WHERE database = 'default' AND name = '${table}') AS sortingKey, (SELECT default_expression FROM system.columns WHERE database = 'default' AND table = '${table}' AND name = 'RetentionDays') AS defaultExpression, (SELECT toString(groupUniqArray(RetentionDays)) FROM ${table}) AS days, (SELECT toString(${table === "trace_index" ? "count()" : "sum(TraceCount)"}) FROM ${table}) AS rows FORMAT JSONEachRow`,
		),
	)[0]

const applyKeyPart = async (db: Chdb) => {
	const steps = await expandMigrationToSteps(sortingKeyPart, "default", async (sql) => db.query(sql))
	for (const step of steps) db.exec(step.sql)
	return steps
}

describeWithChdb("a self-managed v75 store applies 0076's sorting-key change", () => {
	let root = ""
	let opened: Chdb | undefined
	const open = async (label: string, tables: (name: string) => string) => {
		const db = Chdb.open({
			dataDir: join(root, label),
			schemaSql: Arr.join(Arr.map(TABLES, tables), ";\n"),
		})
		opened = db
		db.exec(
			"INSERT INTO trace_index (OrgId, TraceId, ServiceName, Bucket, MinTimestamp, MaxTimestamp) VALUES ('o', 't', 's', now(), now(), now())",
		)
		db.exec(
			"INSERT INTO trace_facets_hourly (OrgId, Hour, ServiceName, SpanName, HasError, TraceCount) VALUES ('o', toStartOfHour(now()), 's', 'GET /', 0, 1)",
		)
		return db
	}

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "maple-retention-sorting-key-"))
	})
	afterAll(async () => {
		opened?.close()
		if (root) await rm(root, { recursive: true, force: true })
	})

	/** The column joined the key with its DEFAULT, every row reads 30, and `rows` survived. */
	const expectKeyed = (db: Chdb, rows = "1") => {
		for (const table of TABLES) {
			db.exec(`OPTIMIZE TABLE ${table} FINAL`)
			const found = keyedColumn(db, table)
			expect(found?.sortingKey, table).toEndWith(", RetentionDays")
			expect(found?.defaultExpression, table).toBe("30")
			expect(found?.days, table).toBe("[30]")
			expect(found?.rows, table).toBe(rows)
		}
	}

	/**
	 * An earlier run that failed after the key ALTER and before the DEFAULT: merges restarted, a
	 * row arrived, and both the merge and the insert stored 0.
	 */
	const failBeforeDefault = (db: Chdb, alters: (table: string) => ReadonlyArray<string>) => {
		for (const table of TABLES) for (const statement of alters(table)) db.exec(statement)
		db.exec(
			"INSERT INTO trace_index (OrgId, TraceId, ServiceName, Bucket, MinTimestamp, MaxTimestamp) VALUES ('o', 'u', 's', now(), now(), now())",
		)
		db.exec(
			"INSERT INTO trace_facets_hourly (OrgId, Hour, ServiceName, SpanName, HasError, TraceCount) VALUES ('o', toStartOfHour(now()), 's', 'GET /', 0, 1)",
		)
		for (const table of TABLES) db.exec(`OPTIMIZE TABLE ${table} FINAL`)
		for (const table of TABLES) expect(keyedColumn(db, table)?.days, table).toBe("[0]")
	}
	const keyAlter = (table: string) =>
		Arr.filter(Arr.filter(sortingKeyPart.statements, Predicate.isString), (stmt) =>
			Str.startsWith(`ALTER TABLE ${table} ADD COLUMN`)(stmt),
		)

	test("a column an older snapshot pass added outside the key is dropped and re-added in it", async () => {
		const db = await open("repair", v75Table)
		for (const table of TABLES)
			db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 30`)
		await applyKeyPart(db)
		expectKeyed(db)
		db.close()
	}, 60_000)

	test("a clean v75 store gains the column in its key, and a rerun plans no drop", async () => {
		const db = await open("clean", v75Table)
		await applyKeyPart(db)
		expectKeyed(db)
		const rerun = await applyKeyPart(db)
		expect(Arr.filter(rerun, (step) => Str.includes("DROP COLUMN")(step.sql))).toEqual([])
		expectKeyed(db)
		db.close()
	}, 60_000)

	test("0s an earlier failed run stored are moved to 30, and no row is lost", async () => {
		const db = await open("zeros", v75Table)
		failBeforeDefault(db, keyAlter)
		await applyKeyPart(db)
		expectKeyed(db, "2")
		db.close()
	}, 60_000)

	test("the local v68 step moves 0s a resumed store holds to 30, and no row is lost", async () => {
		const db = await open("local-zeros", v75Table)
		failBeforeDefault(db, keyAlter)
		const sortingKey = (table: string) =>
			pipe(
				Arr.getUnsafe(keyAlter(table), 0),
				Str.replace(/^.*ORDER BY \((.*)\)$/, "$1"),
				Str.split(","),
				Arr.map(Str.trim),
			)
		for (const statement of stepStatements(
			Arr.map(TABLES, (table) =>
				addSortingColumn(table, ["RetentionDays", "UInt16", "30"], sortingKey(table)),
			),
		))
			db.exec(statement)
		expectKeyed(db, "2")
		db.close()
	}, 60_000)

	test("a store created from the snapshot runs 0076 unchanged", async () => {
		const db = await open("fresh", snapshotTable)
		const steps = await applyKeyPart(db)
		expect(Arr.filter(steps, (step) => Str.includes("DROP COLUMN")(step.sql))).toEqual([])
		expectKeyed(db)
		db.close()
	}, 60_000)
})
