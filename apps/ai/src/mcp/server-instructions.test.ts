import { describe, expect, it } from "@effect/vitest"
import { MAPLE_MCP_SERVER_INSTRUCTIONS } from "./server-instructions"
import { mapleToolCatalog } from "./tools/registry"
import { withFeedbackHint } from "./dispatcher"
import { Array as Arr, String as Str } from "effect"

describe("MCP server instructions", () => {
	it("name only tools that exist", () => {
		const names = new Set(Arr.map(mapleToolCatalog, (tool) => tool.name))
		const mentioned = Arr.map(
			Arr.fromIterable(Str.matchAll(/`([a-z_]+)`/g)(MAPLE_MCP_SERVER_INSTRUCTIONS)),
			(match) => match[1],
		)
		expect(mentioned).toContain("send_maple_feedback")
		for (const name of mentioned) expect(names.has(name ?? "")).toBe(true)
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
