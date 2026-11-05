import { describe, expect, it } from "vitest"
import type { BackfillSpec } from "./backfill"
import { expandBackfill, expandMigrationToSteps, type ExecFn } from "./apply-plan"
import type { ClickHouseMigration } from "./migrations"
import { Array as Arr, String as Str } from "effect"

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
		expect(steps[0].sql).toContain(
			"Timestamp >= toDateTime('2026-01-01 00:00:00') AND Timestamp < toDateTime('2026-01-02 00:00:00')",
		)
		expect(steps[1].sql).toContain("toDateTime('2026-01-02 00:00:00')")
		expect(steps[2].sql).toContain(
			"Timestamp >= toDateTime('2026-01-03 00:00:00') AND Timestamp < toDateTime('2026-01-04 00:00:00')",
		)
		// distinct, stable, date-suffixed step names
		expect(new Set(Arr.map(steps, (s) => s.name)).size).toBe(3)
		expect(steps[0].name).toBe("backfill:service_overview_spans:2026-01-01")
	})

	it("emits a single full step when the source table is empty", async () => {
		const steps = await expandBackfill(spec, "maple", boundsExec(0, 0))
		expect(steps).toHaveLength(1)
		expect(steps[0].name).toContain(":empty")
		expect(steps[0].sql).not.toContain("toDateTime('") // no time predicate
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
		expect(steps[0].backfill).toBe(false)
		// TRUNCATE is not identifier-rewritten by qualify (relies on session db) — passes through.
		expect(steps[0].sql).toBe("TRUNCATE TABLE IF EXISTS service_overview_spans")
		expect(Arr.every(steps.slice(1), (s) => s.backfill)).toBe(true)
	})
})
