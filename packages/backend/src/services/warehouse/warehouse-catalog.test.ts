import { describe, expect, it } from "vitest"
import { describeWarehouseTable, listWarehouseTables, suggestWarehouseTables } from "./warehouse-catalog"

describe("describeWarehouseTable", () => {
	it("returns null for unknown tables", () => {
		expect(describeWarehouseTable("does_not_exist")).toBeNull()
	})

	it("emits ClickHouse type strings (LowCardinality, Map, DateTime64)", () => {
		const info = describeWarehouseTable("logs")
		const orgId = info!.columns.find((c) => c.name === "OrgId")
		expect(orgId?.type).toBe("LowCardinality(String)")
		const ts = info!.columns.find((c) => c.name === "Timestamp")
		expect(ts?.type).toMatch(/DateTime/)
		const attrs = info!.columns.find((c) => c.name === "LogAttributes")
		expect(attrs?.type).toMatch(/^Map\(/)
	})
})

describe("time columns", () => {
	it.each([
		["traces", "Timestamp"],
		["session_replays", "StartTime"],
		["metrics_sum", "TimeUnix"],
		["service_operations_hourly", "Hour"],
		["service_operations_minutely", "Minute"],
	])("names %s's time column as %s", (table, column) => {
		expect(listWarehouseTables().find((t) => t.name === table)?.timeColumn).toBe(column)
		expect(describeWarehouseTable(table)?.notes?.[0]).toContain(`$__timeFilter(${column})`)
	})
})

describe("suggestWarehouseTables", () => {
	it.each([
		["otel_traces", ["traces"]],
		["Spans", ["traces"]],
		["otel_logs", ["logs"]],
		["otel_metrics_sum", ["metrics_sum"]],
		["default.Traces", ["traces"]],
		["metrics", ["metrics_sum", "metrics_gauge", "metrics_histogram"]],
		["nonsense", []],
	])("maps %s to %j", (name, expected) => {
		expect(suggestWarehouseTables(name)).toEqual(expected)
	})
})
