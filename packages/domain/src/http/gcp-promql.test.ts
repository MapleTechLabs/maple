import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { GcpMetricType, GcpPromQlInstantRequest, GcpPromQlRangeRequest } from "./gcp-promql"

const decodeRange = Schema.decodeUnknownExit(GcpPromQlRangeRequest)
const valid = {
	query: "sum(up)",
	startTime: "2026-10-15 11:00:00",
	endTime: "2026-10-15 12:00:00",
	stepSeconds: 60,
}

describe("GcpPromQlRangeRequest", () => {
	it("accepts a query over a window with a step of a minute or more", () => {
		expect(decodeRange({ ...valid, projects: ["acme-prod"] })._tag).toBe("Success")
		// Exactly 11,000 points.
		expect(
			decodeRange({ ...valid, startTime: "2026-10-15 00:00:00", endTime: "2026-10-22 15:20:00" })._tag,
		).toBe("Success")
	})

	it.each([
		["an empty query", { query: "" }],
		["a query over 4,000 characters", { query: `sum(${"x".repeat(4_000)})` }],
		["a step under a minute", { stepSeconds: 30 }],
		["a fractional step", { stepSeconds: 90.5 }],
		["a step over a day", { stepSeconds: 86_401 }],
		["more than 11,000 points a series", { startTime: "2026-09-01 00:00:00" }],
		// 11,000 steps as given, 11,001 once start and end are aligned to the step.
		[
			"more than 11,000 points on the aligned range",
			{ startTime: "2026-10-15 00:00:30", endTime: "2026-10-22 15:20:30" },
		],
		["an inverted window", { startTime: valid.endTime, endTime: valid.startTime }],
		["an impossible date", { endTime: "2026-13-45 99:99:99" }],
		["a project id that is not one", { projects: ["../../organizations/1"] }],
		["more than 20 projects", { projects: Array.from({ length: 21 }, (_, i) => `acme-team-${i + 10}`) }],
	])("refuses %s", (_, change) => {
		expect(decodeRange({ ...valid, ...change })._tag).toBe("Failure")
	})
})

describe("GcpPromQlInstantRequest", () => {
	it("refuses an impossible time", () => {
		const decode = Schema.decodeUnknownExit(GcpPromQlInstantRequest)
		expect(decode({ query: "up", time: "2026-10-15 12:00:00" })._tag).toBe("Success")
		expect(decode({ query: "up", time: "2026-10-15 25:00:00" })._tag).toBe("Failure")
	})
})

describe("GcpMetricType", () => {
	it("admits metric types and nothing that could leave a quoted filter", () => {
		const is = Schema.is(GcpMetricType)
		expect(is("run.googleapis.com/request_count")).toBe(true)
		expect(is("logging.googleapis.com/user/my-metric")).toBe(true)
		expect(is('x" OR metric.type = starts_with("')).toBe(false)
		expect(is("x\\")).toBe(false)
	})
})
