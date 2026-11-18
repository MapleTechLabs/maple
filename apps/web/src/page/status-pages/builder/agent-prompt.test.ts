import { Array as Arr, Option, String as Str } from "effect"
import { describe, expect, test } from "vitest"
import { statusPageAgentPrompt } from "./agent-prompt"

describe("status page agent prompt", () => {
	const prompt = statusPageAgentPrompt("https://api.eu.maple.dev/mcp")

	test("connects the MCP at the org's regional endpoint", () => {
		expect(prompt).toContain("claude mcp add --transport http maple https://api.eu.maple.dev/mcp")
	})

	test("walks the agent through every MCP step from a draft to the publish", () => {
		const tools = [
			"create_uptime_monitor",
			"create_status_page",
			"apply_status_page_config",
			"set_status_page_domain",
			"publish_status_page",
		]
		const order = Arr.map(tools, (tool) => Option.getOrElse(Str.indexOf(tool)(prompt), () => -1))
		expect(Arr.every(order, (index) => index >= 0)).toBe(true)
		expect(order).toEqual(Arr.sort(order, (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0)))
	})

	test("offers the Terraform and Alchemy resources as the code path", () => {
		expect(prompt).toMatch(/maple_status_page/u)
		expect(prompt).toMatch(/Maple\.StatusPage/u)
	})
})
