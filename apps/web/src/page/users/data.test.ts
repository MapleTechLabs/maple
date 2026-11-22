import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { channelSummary, foldRepeats, type UserTrace } from "./data"

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

const request = (traceId: string, rootSpan: string, durationMs: number, isError = false): UserTrace => ({
	traceId,
	atMs: 0,
	rootSpan,
	service: "api",
	durationMs,
	status: isError ? "Error" : "Ok",
	isError,
	href: `/traces/${traceId}`,
})

describe("foldRepeats", () => {
	it("folds back-to-back calls to one operation and opens the slowest", () => {
		const runs = foldRepeats([
			request("a", "initialize", 2),
			request("b", "initialize", 9),
			request("c", "initialize", 4),
			request("d", "GET /cart", 30),
			request("e", "initialize", 1),
		])
		expect(Arr.map(runs, (run) => [run.newest.traceId, run.slowest.traceId, run.count])).toEqual([
			["a", "b", 3],
			["d", "d", 1],
			["e", "e", 1],
		])
	})

	it("keeps a failure apart from the successes around it", () => {
		const runs = foldRepeats([
			request("a", "POST /checkout", 10),
			request("b", "POST /checkout", 12, true),
			request("c", "POST /checkout", 11),
		])
		expect(Arr.map(runs, (run) => run.count)).toEqual([1, 1, 1])
	})
})
