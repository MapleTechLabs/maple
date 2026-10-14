import { describe, expect, it } from "vitest"
import {
	makeQueryBuilderBreakdownDataSource,
	makeQueryBuilderTimeseriesDataSource,
	makeQueryDraft,
} from "@maple/backend/dashboard-templates/helpers"
import { summarizeOutcome, SLOW_RAW_SQL_MS, type InspectionOutcome } from "./inspect-widget"

const widget = {
	id: "w-1",
	visualization: "chart",
	dataSource: { kind: "raw_sql" as const, sql: "SELECT 1" },
	display: { title: "Tile" },
	layout: { x: 0, y: 0, w: 6, h: 4 },
}
const timeRange = {
	startTime: "2026-10-01 00:00:00",
	endTime: "2026-10-02 00:00:00",
	source: "dashboard" as const,
}

const rawSql = (durationMs: number): InspectionOutcome => ({
	kind: "raw_sql",
	data: {
		endpoint: "raw_sql_chart",
		sql: "SELECT 1",
		status: "ok",
		rowCount: 3,
		columns: ["value"],
		rows: [],
		truncated: false,
		timeRange,
		durationMs,
	},
})

describe("summarizeOutcome", () => {
	it("calls a raw-SQL tile that is slow on its own suspicious", () => {
		expect(summarizeOutcome(widget, rawSql(100)).verdict).toBe("looks_healthy")
		const slow = summarizeOutcome(widget, rawSql(SLOW_RAW_SQL_MS + 500))
		expect(slow.verdict).toBe("suspicious")
		expect(slow.note).toContain("may time out")
	})

	describe("seriesCount", () => {
		const draft = makeQueryDraft({ id: "q-a", name: "A", dataSource: "metrics", aggregation: "avg" })
		const query = (status: "ok" | "error", rowCount: number, seriesCount: number) => ({
			queryId: "q",
			queryName: "q",
			status,
			stats: { rowCount, seriesCount, seriesStats: [] },
			flags: [],
		})
		const supported = (queries: ReadonlyArray<ReturnType<typeof query>>): InspectionOutcome => ({
			kind: "supported",
			data: {
				widget: {
					id: "w-1",
					visualization: "chart",
					endpoint: "custom_query_builder_timeseries",
					hasFormulaWarning: false,
					hasUnsupportedTransform: false,
				},
				timeRange,
				queries: [...queries],
				verdict: "looks_healthy",
				flags: [],
				notes: [],
			},
		})

		it("takes the largest chart query, so a formula over its operands is not counted twice", () => {
			const chart = { ...widget, dataSource: makeQueryBuilderTimeseriesDataSource([draft]) }
			const outcome = supported([query("ok", 60, 4), query("ok", 60, 4), query("error", 0, 9)])
			expect(summarizeOutcome(chart, outcome).seriesCount).toBe(4)
		})

		it("counts a breakdown's groups, which are its rows", () => {
			const table = { ...widget, dataSource: makeQueryBuilderBreakdownDataSource([draft]) }
			expect(summarizeOutcome(table, supported([query("ok", 12, 1)])).seriesCount).toBe(12)
		})
	})

	it("scores a funnel widget from its query instead of skipping it", () => {
		const funnel = (first: number): InspectionOutcome => ({
			kind: "unsupported",
			endpoint: "product_events_funnel",
			funnel: { ok: true, steps: 2, first, last: 1 },
		})
		expect(summarizeOutcome(widget, funnel(10))).toMatchObject({
			verdict: "looks_healthy",
			note: "Funnel: 10 at step 1, 1 at step 2.",
		})
		expect(summarizeOutcome(widget, funnel(0)).verdict).toBe("suspicious")
		const failed = summarizeOutcome(widget, {
			kind: "unsupported",
			endpoint: "product_events_funnel",
			funnel: { ok: false, error: "boom" },
		})
		expect(failed.verdict).toBe("broken")
	})
})
