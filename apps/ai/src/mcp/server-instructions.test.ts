import { describe, expect, it } from "@effect/vitest"
import { mcpServerInstructions } from "./server-instructions"
import { mapleToolCatalog } from "./tools/registry"
import { withFeedbackHint } from "./dispatcher"
import { Array as Arr, String as Str } from "effect"

describe("MCP server instructions", () => {
	const toolsNamedIn = (instructions: string) =>
		Arr.map(Arr.fromIterable(Str.matchAll(/`([a-z_]+)`/g)(instructions)), (match) => match[1] ?? "")

	it("name only tools that exist", () => {
		const names = new Set(Arr.map(mapleToolCatalog, (tool) => tool.name))
		const mentioned = toolsNamedIn(mcpServerInstructions({ dataSources: true }))
		expect(mentioned).toContain("send_maple_feedback")
		expect(Arr.filter(mentioned, (name) => !names.has(name))).toEqual([])
	})

	it("name the data source tools only to an org that has data sources", () => {
		expect(toolsNamedIn(mcpServerInstructions({ dataSources: true }))).toEqual([
			"list_data_sources",
			"query_data_source",
			"send_maple_feedback",
		])
		expect(toolsNamedIn(mcpServerInstructions({ dataSources: false }))).toEqual(["send_maple_feedback"])
	})
})

describe("withFeedbackHint", () => {
	it("points outside agents at send_maple_feedback on the public transport only", () => {
		expect(withFeedbackHint("Query failed: boom", "search_traces", "mcp")).toContain(
			"send_maple_feedback",
		)
		expect(withFeedbackHint("Query failed: boom", "search_traces", "chat")).toBe("Query failed: boom")
		expect(withFeedbackHint("Query failed: boom", "search_traces", "bot")).toBe("Query failed: boom")
		expect(withFeedbackHint("Query failed: boom", "send_maple_feedback", "mcp")).toBe(
			"Query failed: boom",
		)
	})
})
