import { describe, expect, it } from "vitest"
import { normalizeToolName, toolLabel } from "./tool-metadata"

describe("normalizeToolName", () => {
	it("strips the mcp__<server>__ namespace prefix", () => {
		expect(normalizeToolName("mcp__maple__list_services")).toBe("list_services")
		expect(normalizeToolName("mcp__maple__service_map")).toBe("service_map")
	})

	it("leaves unprefixed (builtin) tool names untouched", () => {
		expect(normalizeToolName("read")).toBe("read")
		expect(normalizeToolName("bash")).toBe("bash")
	})
})

describe("toolLabel", () => {
	it("falls back to a humanized Title Case label for unmapped tools", () => {
		expect(toolLabel("mcp__maple__some_unknown_tool")).toBe("Some Unknown Tool")
		expect(toolLabel("bash")).toBe("Bash")
	})
})
