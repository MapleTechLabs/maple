import { describe, expect, it } from "vitest"
import type { BackfillSpec } from "./backfill"
import { defaultRestored, expandBackfill, expandMigrationToSteps, type ExecFn } from "./apply-plan"
import type { ClickHouseMigration } from "./migrations"
import { migration_0076_retention_storage } from "./migrations/0076_retention_storage"
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

describe("migration 0076's plan against the cluster", () => {
	/**
	 * A cluster where the column sits outside the key on `unkeyed` tables, and in the key on `keyed`
	 * ones with 0 rows in `zeroPartitions`; `staged` lists the partitions a staging table left by an
	 * earlier run holds (`undefined`: no staging table).
	 */
	const clusterWith =
		(
			unkeyed: ReadonlyArray<string>,
			keyed: ReadonlyArray<string> = [],
			zeroPartitions: ReadonlyArray<string> = [],
			staged?: ReadonlyArray<string>,
		): ExecFn =>
		async (sql) => {
			const names = (tables: ReadonlyArray<string>) =>
				Arr.some(tables, (table) => Str.includes(`table = '${table}'`)(sql))
			const rows = (partitions: ReadonlyArray<string>) =>
				Arr.join(
					Arr.map(partitions, (p) => `{"p":"${p}"}\n`),
					"",
				)
			if (Str.includes("is_in_sorting_key = 0")(sql))
				return names(unkeyed) ? `{"name":"RetentionDays"}\n` : ""
			if (Str.includes("is_in_sorting_key = 1")(sql))
				return names(keyed) ? `{"name":"RetentionDays"}\n` : ""
			if (Str.includes("_partition_id")(sql)) return rows(zeroPartitions)
			if (Str.includes("FROM system.tables")(sql))
				return staged === undefined ? "" : `{"name":"staging"}\n`
			if (Str.includes("FROM system.parts")(sql)) return rows(staged ?? [])
			return ""
		}
	const sqlOf = (steps: ReadonlyArray<{ readonly sql: string }>) => Arr.map(steps, (step) => step.sql)

	it("drops a RetentionDays an older apply added outside the key, before merges stop", async () => {
		const sql = sqlOf(
			await expandMigrationToSteps(
				migration_0076_retention_storage,
				"maple",
				clusterWith(["trace_index"]),
			),
		)
		const drop = sql.indexOf(
			"ALTER TABLE `maple`.`trace_index` DROP COLUMN IF EXISTS RetentionDays SETTINGS mutations_sync = 2",
		)
		expect(drop).toBeGreaterThanOrEqual(0)
		expect(sql.slice(drop + 1, drop + 3)).toEqual([
			"DROP VIEW IF EXISTS trace_index_mv",
			"SYSTEM STOP MERGES trace_index",
		])
		expect(Arr.filter(sql, (statement) => Str.includes("DROP COLUMN")(statement))).toHaveLength(1)
	})

	it("plans no drop where the column is absent or already in the key", async () => {
		const sql = sqlOf(
			await expandMigrationToSteps(migration_0076_retention_storage, "maple", clusterWith([])),
		)
		expect(Arr.filter(sql, (statement) => Str.includes("DROP COLUMN")(statement))).toEqual([])
	})

	it("moves stored 0s to the default through a staging table, once merges run again", async () => {
		const sql = sqlOf(
			await expandMigrationToSteps(
				migration_0076_retention_storage,
				"maple",
				clusterWith([], ["trace_facets_hourly"], ["20261126", "20261125"]),
			),
		)
		const start = sql.indexOf("SYSTEM START MERGES trace_facets_hourly")
		expect(sql.slice(start + 1, start + 7)).toEqual([
			"CREATE TABLE IF NOT EXISTS `maple`.`trace_facets_hourly_retention_repair` AS `maple`.`trace_facets_hourly`",
			"INSERT INTO `maple`.`trace_facets_hourly_retention_repair` SELECT * REPLACE (toUInt16(30) AS RetentionDays) FROM (SELECT * FROM `maple`.`trace_facets_hourly` WHERE RetentionDays = 0) WHERE (SELECT count() FROM `maple`.`trace_facets_hourly_retention_repair`) = 0",
			"ALTER TABLE `maple`.`trace_facets_hourly` DELETE WHERE RetentionDays = 0 SETTINGS mutations_sync = 2",
			"ALTER TABLE `maple`.`trace_facets_hourly_retention_repair` MOVE PARTITION ID '20261126' TO TABLE `maple`.`trace_facets_hourly`",
			"ALTER TABLE `maple`.`trace_facets_hourly_retention_repair` MOVE PARTITION ID '20261125' TO TABLE `maple`.`trace_facets_hourly`",
			"DROP TABLE IF EXISTS `maple`.`trace_facets_hourly_retention_repair`",
		])
		expect(Arr.filter(sql, (statement) => Str.includes("DELETE WHERE")(statement))).toHaveLength(1)
	})

	it("finishes a repair an earlier run left staged, even once no 0 remains", async () => {
		const sql = sqlOf(
			await expandMigrationToSteps(
				migration_0076_retention_storage,
				"maple",
				clusterWith([], ["trace_index"], [], ["20261124"]),
			),
		)
		expect(
			Arr.filter(sql, (statement) => Str.includes("trace_index_retention_repair")(statement)),
		).toEqual([
			"CREATE TABLE IF NOT EXISTS `maple`.`trace_index_retention_repair` AS `maple`.`trace_index`",
			"INSERT INTO `maple`.`trace_index_retention_repair` SELECT * REPLACE (toUInt16(30) AS RetentionDays) FROM (SELECT * FROM `maple`.`trace_index` WHERE RetentionDays = 0) WHERE (SELECT count() FROM `maple`.`trace_index_retention_repair`) = 0",
			"ALTER TABLE `maple`.`trace_index_retention_repair` MOVE PARTITION ID '20261124' TO TABLE `maple`.`trace_index`",
			"DROP TABLE IF EXISTS `maple`.`trace_index_retention_repair`",
		])
	})

	it("plans no repair when no row holds 0 and nothing is staged, or the column is not in the key yet", async () => {
		for (const cluster of [
			clusterWith([], ["trace_index", "trace_facets_hourly"], []),
			clusterWith([], [], ["20261126"]),
		]) {
			const sql = sqlOf(
				await expandMigrationToSteps(migration_0076_retention_storage, "maple", cluster),
			)
			expect(Arr.filter(sql, (statement) => Str.includes("_retention_repair")(statement))).toEqual([])
		}
	})

	it("restarts merges when a step between a stop and its start fails, and only there", async () => {
		const steps = await expandMigrationToSteps(migration_0076_retention_storage, "maple", clusterWith([]))
		const restarts = Arr.flatMap(steps, (step) =>
			step.onFailure === undefined
				? []
				: [[Arr.join(Arr.take(Str.split(" ")(step.sql), 5), " "), step.onFailure] as const],
		)
		expect(restarts).toEqual([
			["ALTER TABLE trace_index ADD COLUMN", "SYSTEM START MERGES trace_index"],
			["ALTER TABLE trace_index MODIFY COLUMN", "SYSTEM START MERGES trace_index"],
			["ALTER TABLE trace_facets_hourly ADD COLUMN", "SYSTEM START MERGES trace_facets_hourly"],
			["ALTER TABLE trace_facets_hourly MODIFY COLUMN", "SYSTEM START MERGES trace_facets_hourly"],
		])
	})

	it("restores each pair's DEFAULT before restarting, and lets merges restart only once it reads back", async () => {
		const steps = await expandMigrationToSteps(migration_0076_retention_storage, "maple", clusterWith([]))
		const restores = Arr.flatMap(steps, (step) =>
			step.restoreBeforeRestart === undefined ? [] : [step.restoreBeforeRestart.sql],
		)
		expect(restores).toEqual([
			"ALTER TABLE trace_index MODIFY COLUMN RetentionDays UInt16 DEFAULT 30",
			"ALTER TABLE trace_index MODIFY COLUMN RetentionDays UInt16 DEFAULT 30",
			"ALTER TABLE trace_facets_hourly MODIFY COLUMN RetentionDays UInt16 DEFAULT 30",
			"ALTER TABLE trace_facets_hourly MODIFY COLUMN RetentionDays UInt16 DEFAULT 30",
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
