import { describe, expect, it } from "vitest"
import { type BackfillSpec, compileBackfillChunk, isBackfill, renderBackfillFull } from "./backfill"

const spec: BackfillSpec = {
	kind: "backfill",
	target: "service_overview_spans",
	columns: ["OrgId", "Timestamp", "ServiceName"],
	from: "traces",
	tsColumn: "Timestamp",
	select: "OrgId,\n  toDateTime(Timestamp) AS Timestamp,\n  ServiceName",
	where: "SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''",
}

describe("isBackfill", () => {
	it("distinguishes specs from raw SQL strings", () => {
		expect(isBackfill(spec)).toBe(true)
		expect(isBackfill("CREATE TABLE x (a Int)")).toBe(false)
		expect(isBackfill(null)).toBe(false)
		expect(isBackfill({ kind: "other" })).toBe(false)
	})
})

describe("renderBackfillFull", () => {
	it("qualifies target + source and emits the column list, no time predicate, no SETTINGS", () => {
		const sql = renderBackfillFull(spec, "maple")
		expect(sql).toContain("INSERT INTO `maple`.`service_overview_spans` (OrgId, Timestamp, ServiceName)")
		expect(sql).toContain("FROM `maple`.`traces`")
		expect(sql).toContain("WHERE (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')")
		expect(sql).not.toContain("toDateTime('")
		expect(sql).not.toContain("SETTINGS")
	})

	it("omits WHERE when the spec has no filter", () => {
		const sql = renderBackfillFull({ ...spec, where: undefined }, "maple")
		expect(sql).not.toContain("WHERE")
	})
})

describe("compileBackfillChunk", () => {
	it("wraps the base filter and ANDs a half-open time window on the raw ts column", () => {
		const sql = compileBackfillChunk(spec, "maple", "2026-01-01 00:00:00", "2026-01-02 00:00:00")
		expect(sql).toContain(
			"WHERE (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '') AND Timestamp >= toDateTime('2026-01-01 00:00:00') AND Timestamp < toDateTime('2026-01-02 00:00:00')",
		)
		// forces raw-column binding so partition pruning works despite the `… AS Timestamp` alias
		expect(sql).toContain("SETTINGS prefer_column_name_to_alias = 1")
	})

	it("emits only the time predicate when there is no base filter", () => {
		const sql = compileBackfillChunk({ ...spec, where: undefined }, "maple", "a", "b")
		expect(sql).toContain("WHERE Timestamp >= toDateTime('a') AND Timestamp < toDateTime('b')")
		expect(sql).not.toContain("()")
	})
})
