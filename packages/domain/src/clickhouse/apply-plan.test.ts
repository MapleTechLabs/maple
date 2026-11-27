import { describe, expect, it } from "vitest"
import type { BackfillSpec } from "./backfill"
import {
	defaultRestored,
	expandBackfill,
	expandMigrationToSteps,
	runZeroKeyRepair,
	type ExecFn,
} from "./apply-plan"
import type { ClickHouseMigration } from "./migrations"
import { migration_0077_retention_storage } from "./migrations/0077_retention_storage"
import { Array as Arr, Option, String as Str } from "effect"

const spec: BackfillSpec = {
	kind: "backfill",
	target: "service_overview_spans",
	columns: ["OrgId", "Timestamp"],
	from: "traces",
	tsColumn: "Timestamp",
	select: "OrgId, toDateTime(Timestamp) AS Timestamp",
	where: "ParentSpanId = ''",
}

// min = 2026-01-01 06:00:00Z, max = 2026-01-03 09:00:00Z → spans 3 day windows.
const LO = Math.floor(Date.UTC(2026, 0, 1, 6, 0, 0) / 1000)
const HI = Math.floor(Date.UTC(2026, 0, 3, 9, 0, 0) / 1000)

const boundsExec =
	(lo: number, hi: number): ExecFn =>
	async (sql) => {
		if (Str.includes("min(")(sql) && Str.includes("max(")(sql)) return `{"lo":${lo},"hi":${hi}}\n`
		return ""
	}

describe("expandBackfill", () => {
	it("splits into day-aligned half-open windows covering [min, max]", async () => {
		const steps = await expandBackfill(spec, "maple", boundsExec(LO, HI))
		expect(steps).toHaveLength(3)
		expect(Arr.every(steps, (s) => s.backfill)).toBe(true)
		expect(Arr.getUnsafe(steps, 0).sql).toContain(
			"Timestamp >= toDateTime('2026-01-01 00:00:00') AND Timestamp < toDateTime('2026-01-02 00:00:00')",
		)
		expect(Arr.getUnsafe(steps, 1).sql).toContain("toDateTime('2026-01-02 00:00:00')")
		expect(Arr.getUnsafe(steps, 2).sql).toContain(
			"Timestamp >= toDateTime('2026-01-03 00:00:00') AND Timestamp < toDateTime('2026-01-04 00:00:00')",
		)
		// distinct, stable, date-suffixed step names
		expect(new Set(Arr.map(steps, (s) => s.name)).size).toBe(3)
		expect(Arr.getUnsafe(steps, 0).name).toBe("backfill:service_overview_spans:2026-01-01")
	})

	it("emits a single full step when the source table is empty", async () => {
		const steps = await expandBackfill(spec, "maple", boundsExec(0, 0))
		expect(steps).toHaveLength(1)
		expect(Arr.getUnsafe(steps, 0).name).toContain(":empty")
		expect(Arr.getUnsafe(steps, 0).sql).not.toContain("toDateTime('") // no time predicate
	})
})

describe("expandMigrationToSteps", () => {
	it("keeps structural statements 1:1 and expands backfills inline in order", async () => {
		const migration: ClickHouseMigration = {
			version: 4,
			description: "test",
			statements: ["TRUNCATE TABLE IF EXISTS service_overview_spans", spec],
		}
		const steps = await expandMigrationToSteps(migration, "maple", boundsExec(LO, HI))
		expect(steps).toHaveLength(1 + 3)
		expect(Arr.getUnsafe(steps, 0).backfill).toBe(false)
		// TRUNCATE is not identifier-rewritten by qualify (relies on session db) — passes through.
		expect(Arr.getUnsafe(steps, 0).sql).toBe("TRUNCATE TABLE IF EXISTS service_overview_spans")
		expect(Arr.every(steps.slice(1), (s) => s.backfill)).toBe(true)
	})
})

describe("migration 0077's plan against the cluster", () => {
	/**
	 * A cluster where the column sits outside the key on `unkeyed` tables, and in the key on `keyed`
	 * ones, which hold 0 rows when `zeros`; `ready` lists the partitions a ready table left by an
	 * earlier run holds (`undefined`: no ready table). `executed` records every statement.
	 */
	const clusterWith = (
		unkeyed: ReadonlyArray<string>,
		keyed: ReadonlyArray<string> = [],
		zeros = false,
		ready?: ReadonlyArray<string>,
	) => {
		const executed: string[] = []
		const exec: ExecFn = async (sql) => {
			executed.push(sql)
			const names = (tables: ReadonlyArray<string>) =>
				Arr.some(tables, (table) => Str.includes(`table = '${table}'`)(sql))
			if (Str.includes("is_in_sorting_key = 0")(sql))
				return names(unkeyed) ? `{"name":"RetentionDays"}\n` : ""
			if (Str.includes("is_in_sorting_key = 1")(sql))
				return names(keyed) ? `{"name":"RetentionDays"}\n` : ""
			if (Str.includes("RetentionDays = 0 LIMIT 1")(sql)) return zeros ? `{"found":1}\n` : ""
			if (Str.includes("FROM system.tables")(sql))
				return ready === undefined ? "" : `{"name":"ready"}\n`
			if (Str.startsWith("SELECT DISTINCT partition_id")(sql))
				return Arr.join(
					Arr.map(ready ?? [], (p) => `{"p":"${p}"}\n`),
					"",
				)
			return ""
		}
		return { executed, exec }
	}
	const sqlOf = (steps: ReadonlyArray<{ readonly sql: string }>) => Arr.map(steps, (step) => step.sql)
	const repairOf = async (table: string, exec: ExecFn) => {
		const steps = await expandMigrationToSteps(migration_0077_retention_storage, "maple", exec)
		return Option.getOrThrow(
			Arr.findFirst(steps, (step) => step.repair?.spec.table === table).pipe(
				Option.flatMapNullishOr((step) => step.repair),
			),
		)
	}
	const writes = (executed: ReadonlyArray<string>) =>
		Arr.filter(
			executed,
			(sql) =>
				!Str.startsWith("SELECT name FROM")(sql) &&
				!Str.startsWith("SELECT 1 AS found")(sql) &&
				!Str.startsWith("SELECT DISTINCT")(sql),
		)

	it("drops a RetentionDays an older apply added outside the key, then stops merges before dropping the view", async () => {
		const sql = sqlOf(
			await expandMigrationToSteps(
				migration_0077_retention_storage,
				"maple",
				clusterWith(["trace_index"]).exec,
			),
		)
		const drop = sql.indexOf(
			"ALTER TABLE `maple`.`trace_index` DROP COLUMN IF EXISTS RetentionDays SETTINGS mutations_sync = 2",
		)
		expect(drop).toBeGreaterThanOrEqual(0)
		expect(sql.slice(drop + 1, drop + 3)).toEqual([
			"SYSTEM STOP MERGES trace_index",
			"DROP VIEW IF EXISTS trace_index_mv",
		])
		expect(Arr.filter(sql, (statement) => Str.includes("DROP COLUMN")(statement))).toHaveLength(1)
	})

	it("plans no drop where the column is absent or already in the key", async () => {
		const sql = sqlOf(
			await expandMigrationToSteps(migration_0077_retention_storage, "maple", clusterWith([]).exec),
		)
		expect(Arr.filter(sql, (statement) => Str.includes("DROP COLUMN")(statement))).toEqual([])
	})

	it("plans each repair right after merges restart, before the column exists, and before the facet TTL", async () => {
		const steps = await expandMigrationToSteps(
			migration_0077_retention_storage,
			"maple",
			clusterWith([]).exec,
		)
		const sql = sqlOf(steps)
		for (const table of ["trace_index", "trace_facets_hourly"]) {
			const repair = Arr.findFirstIndex(steps, (step) => step.repair?.spec.table === table)
			expect(repair, table).toEqual(Option.some(sql.indexOf(`SYSTEM START MERGES ${table}`) + 1))
		}
		const facetRepair = Arr.findFirstIndex(
			steps,
			(step) => step.repair?.spec.table === "trace_facets_hourly",
		).pipe(Option.getOrThrow)
		expect(facetRepair).toBeLessThan(
			Arr.findFirstIndex(sql, (statement) => Str.includes("MODIFY TTL")(statement)).pipe(
				Option.getOrThrow,
			),
		)
	})

	it("moves 0s found when the repair runs through a checked copy, and deletes only once it is ready", async () => {
		const cluster = clusterWith([], ["trace_facets_hourly"], true)
		const repair = await repairOf("trace_facets_hourly", cluster.exec)
		cluster.executed.length = 0
		await runZeroKeyRepair(repair, cluster.exec)
		const staging = "`maple`.`trace_facets_hourly_retention_repair`"
		expect(writes(cluster.executed)).toEqual([
			`DROP TABLE IF EXISTS ${staging}`,
			`CREATE TABLE ${staging} AS \`maple\`.\`trace_facets_hourly\``,
			`SYSTEM STOP MERGES ${staging}`,
			`INSERT INTO ${staging} SELECT * REPLACE (toUInt16(30) AS RetentionDays) FROM (SELECT * FROM \`maple\`.\`trace_facets_hourly\` WHERE RetentionDays = 0)`,
			`SELECT throwIf((SELECT count() FROM ${staging}) != (SELECT count() FROM \`maple\`.\`trace_facets_hourly\` WHERE RetentionDays = 0), 'trace_facets_hourly_retention_repair does not hold every 0 row of trace_facets_hourly; rerun the apply') FORMAT Null`,
			`RENAME TABLE ${staging} TO \`maple\`.\`trace_facets_hourly_retention_repair_ready\``,
			"ALTER TABLE `maple`.`trace_facets_hourly` DELETE WHERE RetentionDays = 0 SETTINGS mutations_sync = 2",
			"SELECT throwIf((SELECT count() FROM (SELECT DISTINCT partition_id AS p FROM system.parts WHERE database = 'maple' AND table = 'trace_facets_hourly_retention_repair_ready' AND active AND rows > 0)) > 0, 'trace_facets_hourly_retention_repair_ready still holds rows not moved back to trace_facets_hourly; rerun the apply') FORMAT Null",
			"DROP TABLE IF EXISTS `maple`.`trace_facets_hourly_retention_repair_ready`",
		])
	})

	it("finishes from a ready copy an earlier run left, without copying again", async () => {
		const cluster = clusterWith([], ["trace_index"], true, ["20261124", "20261125"])
		const repair = await repairOf("trace_index", cluster.exec)
		cluster.executed.length = 0
		await runZeroKeyRepair(repair, cluster.exec)
		expect(writes(cluster.executed)).toEqual([
			"ALTER TABLE `maple`.`trace_index` DELETE WHERE RetentionDays = 0 SETTINGS mutations_sync = 2",
			"ALTER TABLE `maple`.`trace_index_retention_repair_ready` MOVE PARTITION ID '20261124' TO TABLE `maple`.`trace_index`",
			"ALTER TABLE `maple`.`trace_index_retention_repair_ready` MOVE PARTITION ID '20261125' TO TABLE `maple`.`trace_index`",
			"SELECT throwIf((SELECT count() FROM (SELECT DISTINCT partition_id AS p FROM system.parts WHERE database = 'maple' AND table = 'trace_index_retention_repair_ready' AND active AND rows > 0)) > 0, 'trace_index_retention_repair_ready still holds rows not moved back to trace_index; rerun the apply') FORMAT Null",
			"DROP TABLE IF EXISTS `maple`.`trace_index_retention_repair_ready`",
		])
	})

	it("only drops an unchecked copy when no 0 remains, and does nothing before the column is keyed", async () => {
		const clean = clusterWith([], ["trace_index"])
		await runZeroKeyRepair(await repairOf("trace_index", clean.exec), clean.exec)
		expect(Arr.filter(writes(clean.executed), (sql) => Str.includes("_retention_repair")(sql))).toEqual([
			"DROP TABLE IF EXISTS `maple`.`trace_index_retention_repair`",
		])
		const unkeyed = clusterWith([], [], true)
		const repair = await repairOf("trace_index", unkeyed.exec)
		unkeyed.executed.length = 0
		await runZeroKeyRepair(repair, unkeyed.exec)
		expect(writes(unkeyed.executed)).toEqual([])
	})

	it("quotes a database name in every repair statement", async () => {
		const cluster = clusterWith([], ["trace_index"], true)
		const steps = await expandMigrationToSteps(migration_0077_retention_storage, "ma`ple", cluster.exec)
		const repair = Option.getOrThrow(
			Arr.findFirst(steps, (step) => step.repair?.spec.table === "trace_index").pipe(
				Option.flatMapNullishOr((step) => step.repair),
			),
		)
		cluster.executed.length = 0
		await runZeroKeyRepair(repair, cluster.exec)
		expect(Arr.getUnsafe(writes(cluster.executed), 1)).toBe(
			"CREATE TABLE `ma``ple`.`trace_index_retention_repair` AS `ma``ple`.`trace_index`",
		)
	})

	it("restarts merges when a step between a stop and its start fails, and only there", async () => {
		const steps = await expandMigrationToSteps(
			migration_0077_retention_storage,
			"maple",
			clusterWith([]).exec,
		)
		const restarts = Arr.flatMap(steps, (step) =>
			step.onFailure === undefined
				? []
				: [[Arr.join(Arr.take(Str.split(" ")(step.sql), 5), " "), step.onFailure] as const],
		)
		expect(restarts).toEqual([
			["DROP VIEW IF EXISTS trace_index_mv", "SYSTEM START MERGES trace_index"],
			["ALTER TABLE trace_index ADD COLUMN", "SYSTEM START MERGES trace_index"],
			["ALTER TABLE trace_index MODIFY COLUMN", "SYSTEM START MERGES trace_index"],
			["DROP VIEW IF EXISTS trace_facets_hourly_mv", "SYSTEM START MERGES trace_facets_hourly"],
			["ALTER TABLE trace_facets_hourly ADD COLUMN", "SYSTEM START MERGES trace_facets_hourly"],
			["ALTER TABLE trace_facets_hourly MODIFY COLUMN", "SYSTEM START MERGES trace_facets_hourly"],
		])
	})

	it("restores each pair's DEFAULT before restarting, and lets merges restart only once it reads back", async () => {
		const steps = await expandMigrationToSteps(
			migration_0077_retention_storage,
			"maple",
			clusterWith([]).exec,
		)
		const restores = Arr.flatMap(steps, (step) =>
			step.restoreBeforeRestart === undefined ? [] : [step.restoreBeforeRestart.sql],
		)
		expect(restores).toEqual([
			...Arr.replicate("ALTER TABLE trace_index MODIFY COLUMN RetentionDays UInt16 DEFAULT 30", 3),
			...Arr.replicate(
				"ALTER TABLE trace_facets_hourly MODIFY COLUMN RetentionDays UInt16 DEFAULT 30",
				3,
			),
		])
		const restore = Option.getOrThrow(
			Arr.findFirst(steps, (step) => step.restoreBeforeRestart !== undefined).pipe(
				Option.flatMapNullishOr((step) => step.restoreBeforeRestart),
			),
		)
		expect(defaultRestored(restore, '{"default_expression":"30"}\n')).toBe(true)
		// No column: the key ALTER never ran, so nothing can store its 0.
		expect(defaultRestored(restore, "")).toBe(true)
		expect(defaultRestored(restore, '{"default_expression":""}\n')).toBe(false)
	})
})
