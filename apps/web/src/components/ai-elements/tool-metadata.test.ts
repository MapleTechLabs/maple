import { describe, expect, it } from "vitest"
import { normalizeToolName, toolIcon, toolLabel } from "./tool-metadata"

describe("normalizeToolName", () => {
	it("strips the mcp__<server>__ namespace prefix", () => {
		expect(normalizeToolName("mcp__maple__list_services")).toBe("list_services")
		expect(normalizeToolName("mcp__maple__service_map")).toBe("service_map")
	})

	it("works for other server namespaces", () => {
		expect(normalizeToolName("mcp__other__do_thing")).toBe("do_thing")
	})

	it("leaves unprefixed (builtin) tool names untouched", () => {
		expect(normalizeToolName("read")).toBe("read")
		expect(normalizeToolName("bash")).toBe("bash")
	})
})

describe("toolLabel", () => {
	it("maps known Maple tools to friendly labels (despite the namespace prefix)", () => {
		expect(toolLabel("mcp__maple__list_services")).toBe("List Services")
		expect(toolLabel("mcp__maple__find_errors")).toBe("Find Errors")
		expect(toolLabel("mcp__maple__service_map")).toBe("Service Map")
	})

	it("falls back to a humanized Title Case label for unmapped tools", () => {
		expect(toolLabel("mcp__maple__some_unknown_tool")).toBe("Some Unknown Tool")
		expect(toolLabel("bash")).toBe("Bash")
	})
})

describe("toolIcon", () => {
	it("returns an icon component for known and unknown tools", () => {
		expect(typeof toolIcon("mcp__maple__list_services")).toBe("function")
		expect(typeof toolIcon("mcp__maple__totally_unknown")).toBe("function")
	})
})
