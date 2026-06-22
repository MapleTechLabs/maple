import { describe, expect, it } from "vitest"
import { buildApiDeclaration, clampDesc, escapeJsDoc, inputTypeForTool, tsTypeForSchema } from "./api-gen.ts"
import type { JsonSchema } from "./types.ts"

describe("tsTypeForSchema", () => {
	it("maps primitives", () => {
		expect(tsTypeForSchema({ type: "string" })).toBe("string")
		expect(tsTypeForSchema({ type: "integer" })).toBe("number")
		expect(tsTypeForSchema({ type: "number" })).toBe("number")
		expect(tsTypeForSchema({ type: "boolean" })).toBe("boolean")
	})

	it("renders arrays of the item type", () => {
		expect(tsTypeForSchema({ type: "array", items: { type: "string" } })).toBe("string[]")
	})

	it("renders small string enums as literal unions", () => {
		expect(tsTypeForSchema({ enum: ["traces", "logs", "metrics"] })).toBe(
			'"traces" | "logs" | "metrics"',
		)
	})

	it("falls back to string for a giant enum", () => {
		const big = Array.from({ length: 20 }, (_, i) => `v${i}`)
		expect(tsTypeForSchema({ type: "string", enum: big })).toBe("string")
	})

	it("collapses deeply nested objects to Record", () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "string" } } } } },
			},
		}
		const out = tsTypeForSchema(schema, 0)
		expect(out).toContain("Record<string, unknown>")
	})

	it("treats optional-vs-required via the required array", () => {
		const schema: JsonSchema = {
			type: "object",
			properties: { id: { type: "string" }, limit: { type: "integer" } },
			required: ["id"],
		}
		const out = inputTypeForTool(schema)
		expect(out).toContain("id: string")
		expect(out).toContain("limit?: number")
	})

	it("renders anyOf as a union", () => {
		expect(tsTypeForSchema({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe(
			"string | number",
		)
	})
})

describe("inputTypeForTool", () => {
	it("returns a Record for a parameterless tool", () => {
		expect(inputTypeForTool(undefined)).toBe("Record<string, unknown>")
		expect(inputTypeForTool({ type: "object", properties: {} })).toBe("Record<string, unknown>")
	})
})

describe("escapeJsDoc / clampDesc", () => {
	it("neutralizes a comment terminator", () => {
		expect(escapeJsDoc("ends here */ and more")).toBe("ends here *\\/ and more")
	})

	it("collapses whitespace and clamps length", () => {
		expect(clampDesc("  a\n  b   c ", 50)).toBe("a b c")
		expect(clampDesc("abcdefgh", 6)).toBe("abc...")
	})
})

describe("buildApiDeclaration", () => {
	it("emits one sorted, JSDoc'd method per tool returning Promise<string>", () => {
		const decl = buildApiDeclaration([
			{
				name: "find_errors",
				description: "Find errors",
				parameters: { type: "object", properties: { service: { type: "string", description: "svc name */ x" } } },
			},
			{ name: "compare_periods", description: "Compare two periods", parameters: undefined },
		])
		// sorted: compare_periods before find_errors
		expect(decl.indexOf("compare_periods")).toBeLessThan(decl.indexOf("find_errors"))
		expect(decl).toContain("declare const maple: {")
		expect(decl).toContain("find_errors(input: { /** svc name *\\/ x */ service?: string }): Promise<string>;")
		expect(decl).toContain("compare_periods(input: Record<string, unknown>): Promise<string>;")
		expect(decl).not.toContain("*/ x */ service") // terminator escaped
	})
})
