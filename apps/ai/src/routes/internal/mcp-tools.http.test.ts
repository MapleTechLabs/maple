import { describe, expect, it } from "vitest"
import { mapleToolCatalog, mapleToolCatalogFor } from "../../mcp/tools/registry"
import { publicMcpToolCatalog } from "./mcp-tools.http"
import { Array as Arr, Option } from "effect"

describe("publicMcpToolCatalog", () => {
	const { tools } = publicMcpToolCatalog()

	it("lists exactly what the public MCP transport serves", () => {
		expect(Arr.map(tools, (tool) => tool.name).sort()).toEqual(
			Arr.map(mapleToolCatalogFor("mcp"), (tool) => tool.name).sort(),
		)
	})

	it("leaves out tools meant only for Maple's own agents", () => {
		const listed = new Set(Arr.map(tools, (tool) => tool.name))
		const agentOnly = Arr.filter(mapleToolCatalog, (tool) => tool.audience !== "public")
		expect(agentOnly.length).toBeGreaterThan(0)
		for (const tool of agentOnly) expect(listed.has(tool.name)).toBe(false)
	})

	it("carries each tool's read-only and destructive hints", () => {
		for (const tool of mapleToolCatalogFor("mcp")) {
			const listed = Option.getOrUndefined(Arr.findFirst(tools, (entry) => entry.name === tool.name))
			expect(listed?.readOnly).toBe(tool.hints.readOnly)
			expect(listed?.destructive).toBe(tool.hints.destructive === true)
		}
	})
})
