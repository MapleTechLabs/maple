import { describe, expect, it } from "vitest"

import { AiOverviewMeasures } from "@maple/domain/http"

import {
	mapOverviewBreakdown,
	mapOverviewMeasures,
	mapOverviewModelMix,
	mapOverviewSeries,
} from "./ai-agent-overview"

const wire = (overrides: Partial<AiOverviewMeasures> = {}): AiOverviewMeasures => ({
	sessions: 10,
	erroredSessions: 1,
	llmCalls: 80,
	llmCallSpans: 94,
	erroredLlmCalls: 3,
	toolCalls: 63,
	erroredToolCalls: 2,
	cost: 2.64,
	pricedLlmCalls: 88,
	tokens: 674_000,
	inputTokens: 152_000,
	cacheReadTokens: 373_000,
	cacheWriteTokens: 27_000,
	outputTokens: 81_000,
	reasoningTokens: 41_000,
	sessionDurationP50Ns: 42_000_000_000,
	sessionDurationP95Ns: 96_000_000_000,
	llmDurationP50Ns: 1_900_000_000,
	llmDurationP95Ns: 7_400_000_000,
	...overrides,
})

describe("mapOverviewMeasures", () => {
	it("converts the session quantiles from nanoseconds to milliseconds", () => {
		const row = mapOverviewMeasures(wire())
		expect(row.sessionDurationP50Ms).toBe(42_000)
		expect(row.sessionDurationP95Ms).toBe(96_000)
	})

	it("drops the per-call quantiles, which nothing on the board reads", () => {
		const row = mapOverviewMeasures(wire())
		expect(row).not.toHaveProperty("llmDurationP50Ms")
		expect(row).not.toHaveProperty("llmDurationP95Ms")
	})

	it("carries the raw span population separately from the netted volume", () => {
		const row = mapOverviewMeasures(wire())
		expect(row.llmCalls).toBe(80)
		expect(row.llmCallSpans).toBe(94)
	})
})

describe("mapOverviewSeries", () => {
	it("reads a bucket as UTC rather than as local time", () => {
		const [point] = mapOverviewSeries([{ bucket: "2026-09-10T12:00:00.000Z", ...wire() }])
		expect(point.bucket).toBe(Date.UTC(2026, 8, 10, 12, 0, 0))
	})
})

describe("mapOverviewBreakdown", () => {
	it("keeps both windows per key, and `''` as a real key", () => {
		const [row] = mapOverviewBreakdown([
			{ key: "", current: wire(), previous: wire({ sessions: 4 }) },
		])
		expect(row.key).toBe("")
		expect(row.current.sessions).toBe(10)
		expect(row.previous.sessions).toBe(4)
	})
})

describe("mapOverviewModelMix", () => {
	it("reads the bucket as UTC and leaves the model alone", () => {
		const [row] = mapOverviewModelMix([
			{ bucket: "2026-09-10T18:00:00.000Z", model: "claude-opus-5", llmCallSpans: 42 },
		])
		expect(row.bucket).toBe(Date.UTC(2026, 8, 10, 18, 0, 0))
		expect(row.model).toBe("claude-opus-5")
		expect(row.llmCallSpans).toBe(42)
	})
})
