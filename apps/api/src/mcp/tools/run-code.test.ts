import { describe, expect, it, vi } from "vitest"
import type { McpToolResult } from "./types"
import { mapleToolDefinitions } from "./registry"
import { resolveCodeModeCall, textOfResult } from "./run-code"

const call = (
	name: string,
	input: unknown,
	invoke: (definition: (typeof mapleToolDefinitions)[number], decoded: unknown) => Promise<McpToolResult>,
) => resolveCodeModeCall(mapleToolDefinitions, name, input, invoke)

const okResult = (text: string, structured?: string): McpToolResult => ({
	content: structured
		? [
				{ type: "text", text },
				{ type: "text", text: structured },
			]
		: [{ type: "text", text }],
})

describe("textOfResult", () => {
	it("joins dual content under the Structured content: convention", () => {
		expect(textOfResult(okResult("human", '{"a":1}'))).toBe('human\n\nStructured content:\n{"a":1}')
	})
	it("returns the single text entry as-is", () => {
		expect(textOfResult(okResult("just text"))).toBe("just text")
	})
})

describe("resolveCodeModeCall", () => {
	it("blocks mutating tools without invoking them", async () => {
		const invoke = vi.fn()
		const r = await call("create_dashboard", {}, invoke)
		expect(r.ok).toBe(false)
		expect(r.error?.name).toBe("MutatingToolBlocked")
		expect(invoke).not.toHaveBeenCalled()
	})

	it("refuses to call run_code from inside code mode (no nested sandbox)", async () => {
		const invoke = vi.fn()
		const r = await call("run_code", { code: "1" }, invoke)
		expect(r.ok).toBe(false)
		expect(r.error?.name).toBe("Blocked")
		expect(invoke).not.toHaveBeenCalled()
	})

	it("rejects unknown tools", async () => {
		const r = await call("not_a_tool", {}, vi.fn())
		expect(r.ok).toBe(false)
		expect(r.error?.name).toBe("UnknownTool")
	})

	it("rejects input that fails the tool schema before invoking", async () => {
		const invoke = vi.fn()
		// list_services takes only optional strings; a number for `environment` is invalid.
		const r = await call("list_services", { environment: 123 }, invoke)
		expect(r.ok).toBe(false)
		expect(r.error?.name).toBe("InvalidInput")
		expect(invoke).not.toHaveBeenCalled()
	})

	it("runs a read tool and returns its text on success", async () => {
		const invoke = vi.fn(async () => okResult("Services table", '{"total":2}'))
		const r = await call("list_services", { environment: "production" }, invoke)
		expect(invoke).toHaveBeenCalledOnce()
		expect(r.ok).toBe(true)
		expect(r.value).toContain("Services table")
		expect(r.value).toContain("Structured content:")
	})

	it("surfaces an isError tool result as an error value", async () => {
		const invoke = vi.fn(async (): Promise<McpToolResult> => ({
			isError: true,
			content: [{ type: "text", text: "warehouse exploded" }],
		}))
		const r = await call("list_services", {}, invoke)
		expect(r.ok).toBe(false)
		expect(r.error?.name).toBe("ToolError")
		expect(r.error?.message).toContain("warehouse exploded")
	})
})
