import { describe, expect, it } from "vitest"
import { channelSummary } from "./data"

describe("channelSummary", () => {
	it("names the top channel with its share and the whole split", () => {
		expect(
			channelSummary([
				{ channel: "mcp", requests: 92 },
				{ channel: "web", requests: 8 },
			]),
		).toEqual({ label: "MCP", share: "92%", split: "MCP 92% · Web 8%" })
	})

	it("drops the share when one channel has every request", () => {
		expect(channelSummary([{ channel: "mobile", requests: 40 }])).toEqual({
			label: "Mobile",
			share: null,
			split: "Mobile 100%",
		})
	})

	it("shows a sliver as under one percent", () => {
		expect(
			channelSummary([
				{ channel: "api", requests: 999 },
				{ channel: "web", requests: 1 },
			])?.split,
		).toBe("API 100% · Web <1%")
	})

	it("is null without classified requests", () => {
		expect(channelSummary([])).toBeNull()
	})
})
