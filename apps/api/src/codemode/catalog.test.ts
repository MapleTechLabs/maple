import { describe, expect, it } from "vitest"
import { buildMapleCodeModeCatalog, isMutatingTool } from "./catalog"
import { mapleToolDefinitions } from "../mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"

describe("buildMapleCodeModeCatalog", () => {
	const catalog = buildMapleCodeModeCatalog()

	it("exposes exactly one descriptor per registered tool", () => {
		expect(catalog).toHaveLength(mapleToolDefinitions.length)
		const names = new Set(catalog.map((tool) => tool.name))
		for (const definition of mapleToolDefinitions) {
			expect(names.has(definition.name), `missing catalog entry: ${definition.name}`).toBe(true)
		}
	})

	it("flags every mutating tool as requiresApproval", () => {
		for (const tool of catalog) {
			expect(tool.requiresApproval, tool.name).toBe(MUTATING_TOOL_NAMES.has(tool.name))
		}
		// Spot-check both sides so a silently-empty MUTATING_TOOL_NAMES would fail.
		const byName = new Map(catalog.map((tool) => [tool.name, tool]))
		expect(byName.get("create_alert_rule")?.requiresApproval).toBe(true)
		expect(byName.get("update_dashboard_widget")?.requiresApproval).toBe(true)
		expect(byName.get("find_errors")?.requiresApproval).toBe(false)
		expect(byName.get("search_traces")?.requiresApproval).toBe(false)
	})

	it("produces a JSON-Schema object input for every tool", () => {
		for (const tool of catalog) {
			expect(tool.inputSchema, tool.name).toBeTypeOf("object")
			// Effect's toJsonSchemaDocument emits object schemas for Struct params.
			expect((tool.inputSchema as { type?: string }).type, tool.name).toBe("object")
		}
	})

	it("carries a non-empty description for every tool", () => {
		for (const tool of catalog) {
			expect(tool.description.length, tool.name).toBeGreaterThan(0)
		}
	})
})

describe("isMutatingTool", () => {
	it("matches MUTATING_TOOL_NAMES membership", () => {
		expect(isMutatingTool("create_dashboard")).toBe(true)
		expect(isMutatingTool("propose_fix")).toBe(true)
		expect(isMutatingTool("list_services")).toBe(false)
		expect(isMutatingTool("definitely_not_a_tool")).toBe(false)
	})
})
