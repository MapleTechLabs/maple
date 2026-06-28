import { describe, expect, it, vi } from "vitest"
import type { ToolDefinition } from "@flue/runtime"
import type { CodeProposal } from "@maple/codemode"
import { buildCodeModeApi } from "./api-gen.ts"
import { createCodeModeDispatch } from "./run-code-tool.ts"

const tool = (name: string, execute: ToolDefinition["execute"], parameters: object = { type: "object", properties: {} }): ToolDefinition => ({
	name,
	description: `desc for ${name}`,
	parameters,
	execute,
})

describe("buildCodeModeApi", () => {
	it("strips the mcp__maple__ prefix and builds a declaration + dispatch", () => {
		const tools = [
			tool("mcp__maple__find_errors", async () => "errors", {
				type: "object",
				properties: { service: { type: "string", description: "svc" } },
				required: [],
			}),
			tool("mcp__maple__list_services", async () => "services"),
		]
		const api = buildCodeModeApi(tools)
		expect(api.toolNames).toContain("find_errors")
		expect(api.toolNames).toContain("list_services")
		expect(api.declaration).toContain("find_errors(input: { /** svc */ service?: string }): Promise<string>;")
		expect(api.dispatch.get("find_errors")).toBeTypeOf("function")
	})

	it("keeps the first tool when base names collide", () => {
		const first = vi.fn(async () => "first")
		const second = vi.fn(async () => "second")
		const api = buildCodeModeApi([tool("mcp__maple__x", first), tool("x", second)])
		expect(api.dispatch.size).toBe(1)
		expect(api.dispatch.get("x")).toBe(first)
	})
})

describe("createCodeModeDispatch", () => {
	it("returns ok:false for an unknown tool", async () => {
		const dispatch = createCodeModeDispatch(new Map(), () => {})
		const r = await dispatch("nope", {})
		expect(r.ok).toBe(false)
		expect(r.error?.name).toBe("UnknownTool")
	})

	it("runs a read tool and returns its value", async () => {
		const map = new Map<string, ToolDefinition["execute"]>([["list_services", async () => "services table"]])
		const r = await createCodeModeDispatch(map, () => {})("list_services", { environment: "prod" })
		expect(r).toEqual({ ok: true, value: "services table" })
	})

	it("collects a proposal from a gated mutating tool while returning its value", async () => {
		const proposals: CodeProposal[] = []
		// Gated mutating execute returns a proposal marker instead of mutating.
		const gated: ToolDefinition["execute"] = async (args) =>
			JSON.stringify({ status: "proposed", tool: "create_dashboard", input: args })
		const map = new Map<string, ToolDefinition["execute"]>([["create_dashboard", gated]])
		const r = await createCodeModeDispatch(map, (p) => proposals.push(p))("create_dashboard", { title: "x" })
		expect(r.ok).toBe(true)
		expect(proposals).toEqual([{ tool: "create_dashboard", input: { title: "x" } }])
	})
})
