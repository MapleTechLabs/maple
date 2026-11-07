import { describe, expect, it } from "vitest"
import { String as Str } from "effect"
import { attributeScanOf, spanBudgetMessage } from "./run-sql-span-budget"

const MACRO_WINDOW = { startTime: "2026-11-01 00:00:00", endTime: "2026-11-07 00:00:00", applied: true }
const NO_MACRO = { ...MACRO_WINDOW, applied: false }

describe("attributeScanOf", () => {
	it("sizes a raw traces attribute read over the macro window, with its services", () => {
		expect(
			attributeScanOf(
				"SELECT count() FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND ServiceName IN ('api', 'web') AND SpanAttributes['http.route'] LIKE '%x%'",
				MACRO_WINDOW,
			),
		).toEqual({
			startTime: "2026-11-01 00:00:00",
			endTime: "2026-11-07 00:00:00",
			services: ["api", "web"],
			literalWindow: false,
		})
	})

	it("reads the SQL's own Timestamp bounds when no macro applies the window", () => {
		expect(
			attributeScanOf(
				"SELECT count() FROM traces WHERE $__orgFilter AND Timestamp >= toDateTime('2026-10-17 00:00:00') AND Timestamp <= toDateTime('2026-10-31 16:05:50') AND SpanAttributes['k'] != ''",
				NO_MACRO,
			),
		).toEqual({
			startTime: "2026-10-17 00:00:00",
			endTime: "2026-10-31 16:05:50",
			services: undefined,
			literalWindow: true,
		})
	})

	it.each([
		["no attribute map", "SELECT count() FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)"],
		[
			"not traces",
			"SELECT count() FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp) AND LogAttributes['k'] = ''",
		],
		[
			"a trace-id lookup",
			"SELECT SpanAttributes FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND TraceId = 'abc'",
		],
		[
			"a service filter it cannot read",
			"SELECT count() FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND ServiceName LIKE 'api%' AND SpanAttributes['k'] = ''",
		],
		["no window at all", "SELECT count() FROM traces WHERE $__orgFilter AND SpanAttributes['k'] = ''"],
	])("leaves %s alone", (_, sql) => {
		expect(
			attributeScanOf(sql, Str.includes("$__timeFilter")(sql) ? MACRO_WINDOW : NO_MACRO),
		).toBeUndefined()
	})

	it("skips windows of an hour or less", () => {
		expect(
			attributeScanOf(
				"SELECT count() FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND SpanAttributes['k'] = ''",
				{
					startTime: "2026-11-07 10:00:00",
					endTime: "2026-11-07 11:00:00",
					applied: true,
				},
			),
		).toBeUndefined()
	})
})

describe("spanBudgetMessage", () => {
	it("names the estimate and a start_time that fits", () => {
		const message = spanBudgetMessage(
			{
				startTime: "2026-11-01 00:00:00",
				endTime: "2026-11-07 00:00:00",
				services: undefined,
				literalWindow: false,
			},
			956_000_000,
			4 * 3600,
		)
		expect(message).toContain("about 956M spans across every service")
		expect(message).toContain(
			"4 hours or less (e.g. start_time='2026-11-06 20:00:00', end_time='2026-11-07 00:00:00')",
		)
		expect(message).toContain("filter on `ServiceName")
	})

	it("points at the SQL's bounds when the window is its own", () => {
		const message = spanBudgetMessage(
			{
				startTime: "2026-11-01 00:00:00",
				endTime: "2026-11-07 00:00:00",
				services: ["api"],
				literalWindow: true,
			},
			120_000_000,
			36 * 3600,
		)
		expect(message).toContain("for `api`")
		expect(message).toContain("Narrow the query's Timestamp bounds to 36 hours or less")
		expect(message).not.toContain("filter on `ServiceName")
	})
})
