import { describe, expect, it } from "vitest"
import { mapleToolCatalog, mapleToolCatalogFor } from "../../mcp/tools/registry"
import { publicMcpToolCatalog } from "./mcp-tools.http"

describe("publicMcpToolCatalog", () => {
	const { tools } = publicMcpToolCatalog()

	it("lists exactly what the public MCP transport serves", () => {
		expect(tools.map((tool) => tool.name).sort()).toEqual(
			mapleToolCatalogFor("mcp")
				.map((tool) => tool.name)
				.sort(),
		)
	})

	it("leaves out tools meant only for Maple's own agents", () => {
		const listed = new Set(tools.map((tool) => tool.name))
		const agentOnly = mapleToolCatalog.filter((tool) => tool.audience !== "public")
		expect(agentOnly.length).toBeGreaterThan(0)
		for (const tool of agentOnly) expect(listed.has(tool.name)).toBe(false)
	})

	it("carries each tool's read-only and destructive hints", () => {
		for (const tool of mapleToolCatalogFor("mcp")) {
			const listed = tools.find((entry) => entry.name === tool.name)
			expect(listed?.readOnly).toBe(tool.hints.readOnly)
			expect(listed?.destructive).toBe(tool.hints.destructive === true)
		}
	})
})
