import { describe, expect, it } from "@effect/vitest"
import { MAPLE_MCP_SERVER_INSTRUCTIONS } from "./server-instructions"
import { mapleToolCatalog } from "./tools/registry"
import { withFeedbackHint } from "./dispatcher"

describe("MCP server instructions", () => {
	it("name only tools that exist", () => {
		const names = new Set(mapleToolCatalog.map((tool) => tool.name))
		const mentioned = [...MAPLE_MCP_SERVER_INSTRUCTIONS.matchAll(/`([a-z_]+)`/g)].map((match) => match[1])
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
