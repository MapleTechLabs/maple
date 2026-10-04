import { describe, expect, it } from "vitest"
import { Result } from "effect"
import { mergePatch, patchWidget } from "./dashboard-widget-patch"

const widget = {
	id: "w-1",
	visualization: "chart",
	dataSource: { kind: "raw_sql" as const, sql: "SELECT 1" },
	display: { title: "Old", unit: "ms" },
	layout: { x: 0, y: 0, w: 6, h: 4 },
}

describe("mergePatch", () => {
	it("merges objects, replaces arrays and deletes on null", () => {
		expect(mergePatch({ a: { b: 1, c: 2 }, d: [1, 2] }, { a: { c: null, e: 3 }, d: [9] })).toEqual({
			a: { b: 1, e: 3 },
			d: [9],
		})
	})
})

describe("patchWidget", () => {
	it("applies title and chart_id over a patch, keeping the id", () => {
		const result = patchWidget(widget, {
			patch: { id: "other", dataSource: { sql: "SELECT 2" } },
			title: "New",
			chartId: "bar-chart",
		})
		expect(Result.isSuccess(result) && result.success).toMatchObject({
			id: "w-1",
			dataSource: { kind: "raw_sql", sql: "SELECT 2" },
			display: { title: "New", unit: "ms", chartId: "bar-chart" },
		})
	})

	it("rejects a patch that leaves an invalid widget", () => {
		const result = patchWidget(widget, { patch: { layout: { w: "wide" } } })
		expect(Result.isFailure(result) && result.failure).toContain("The patched widget is not valid")
	})
})
