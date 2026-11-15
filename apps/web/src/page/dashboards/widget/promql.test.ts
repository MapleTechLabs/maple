import { DashboardWidgetSchema } from "@maple/domain/http"
import { dataSourceTransform } from "@maple/widgets/dashboard"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { EditorState } from "./editor-state"
import { promqlDataSourceOf, promqlDraftOf } from "./promql"

const table = Schema.decodeSync(DashboardWidgetSchema)({
	id: "jobs",
	visualization: "table",
	dataSource: { kind: "promql", query: "up", displayType: "table", transform: { limit: 50 } },
	display: { title: "Jobs" },
	layout: { x: 0, y: 0, w: 6, h: 4 },
})
const draft = { query: "up", legendFormat: "", minStepSeconds: null }
const state: Pick<EditorState, "visualization" | "chartId" | "statAggregate"> = {
	visualization: "table",
	chartId: "",
	statAggregate: "first",
}

describe("promqlDataSourceOf", () => {
	it("writes the table's Row limit, and clearing it removes the stored one", () => {
		const limitOf = (tableLimit: string) =>
			dataSourceTransform(promqlDataSourceOf(table, draft, { ...state, tableLimit }))?.limit
		expect(limitOf("10")).toBe(10)
		expect(limitOf("")).toBeUndefined()
	})

	it("drops a stored row limit when the panel is not a table", () => {
		const line = promqlDataSourceOf(table, draft, { ...state, visualization: "chart", tableLimit: "" })
		expect(dataSourceTransform(line)?.limit).toBeUndefined()
	})

	it("keeps an empty stored query empty, so Apply refuses it instead of saving the template", () => {
		const empty = Schema.decodeSync(DashboardWidgetSchema)({
			id: "empty",
			visualization: "chart",
			dataSource: { kind: "promql", query: "", legendFormat: "{{job}}" },
			display: { title: "Empty" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		})
		expect(promqlDraftOf(empty)).toEqual({ query: "", legendFormat: "{{job}}", minStepSeconds: null })
	})
})
