import { describe, expect, it } from "vitest"

import { AiToolsSeriesResponse } from "@maple/domain/http"

import { OTHER_SERIES_KEY } from "@/lib/agent-sessions/tool-analytics"

import { mapToolBreakdown, mapToolSeries, mapToolSessions } from "./ai-session-tools"

const measures = { calls: 3, sessions: 1, errors: 0, p50: 1_000, p90: 2_000, p95: 3_000 }

const seriesOf = (keys: ReadonlyArray<string>) =>
	mapToolSeries(
		new AiToolsSeriesResponse({
			seriesKind: "model",
			data: keys.map((seriesKey) => ({ bucket: "2026-09-10T12:00:00.000Z", seriesKey, ...measures })),
		}),
	)

describe("mapToolSeries", () => {
	it("reads a bucket as UTC rather than as local time", () => {
		expect(seriesOf(["gpt-5"])[0]?.bucket).toBe(Date.UTC(2026, 8, 10, 12, 0, 0))
	})

	it("names the unattributed key instead of drawing a blank legend entry", () => {
		expect(seriesOf([""])[0]?.seriesKey).toBe("Unattributed")
	})

	it("adopts the API's folded tail as the page's own", () => {
		// Both sides fold; sharing one key is what keeps them one line.
		expect(seriesOf(["other"])[0]?.seriesKey).toBe(OTHER_SERIES_KEY)
	})

	it("leaves every real key alone", () => {
		expect(seriesOf(["openai/gpt-5.6"])[0]?.seriesKey).toBe("openai/gpt-5.6")
	})
})

describe("mapToolBreakdown", () => {
	it("reads a bare warehouse datetime as UTC", () => {
		const [row] = mapToolBreakdown([
			{ key: "bash", ...measures, lastSeen: "2026-09-10 11:59:00" },
		])
		expect(row?.lastSeen).toBe(Date.UTC(2026, 8, 10, 11, 59, 0))
	})
})

describe("mapToolSessions", () => {
	it("keeps durations in nanoseconds and the session key verbatim", () => {
		const [row] = mapToolSessions([
			{
				sessionId: "trace:abc",
				agentName: "",
				model: "gpt-5",
				serviceName: "api",
				calls: 4,
				errors: 1,
				avgDurationNs: 2_500_000,
				maxDurationNs: 11_000_000,
				startedAt: "2026-09-10 11:00:00",
			},
		])
		expect(row?.sessionId).toBe("trace:abc")
		expect(row?.avgDurationNs).toBe(2_500_000)
		expect(row?.startedAt).toBe(Date.UTC(2026, 8, 10, 11, 0, 0))
	})
})
