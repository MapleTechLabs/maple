import { describe, expect, it } from "vitest"

import {
	EMPTY_OVERVIEW_MEASURES,
	OVERVIEW_MOVER_LIMIT,
	buildAgentOverviewData,
	buildBreakdownRows,
	buildModelMix,
	buildMovers,
	buildOverviewSeries,
	buildOverviewTiles,
	cacheHitRatio,
	costPerSession,
	formatOverviewCount,
	formatOverviewDuration,
	formatPerSession,
	llmErrorRate,
	overviewDelta,
	overviewScopeSummary,
	pricedShare,
	sessionErrorRate,
	shiftOverviewSeries,
	tokenBandValues,
	toolErrorRate,
	tokensPerSession,
	type OverviewMeasures,
} from "./overview-analytics"

const measures = (overrides: Partial<OverviewMeasures>): OverviewMeasures => ({
	...EMPTY_OVERVIEW_MEASURES,
	...overrides,
})

describe("derivations", () => {
	it("divides by zero as zero rather than as NaN", () => {
		const empty = EMPTY_OVERVIEW_MEASURES
		for (const value of [
			sessionErrorRate(empty),
			llmErrorRate(empty),
			toolErrorRate(empty),
			costPerSession(empty),
			tokensPerSession(empty),
			cacheHitRatio(empty),
			pricedShare(empty),
		]) {
			expect(value).toBe(0)
		}
	})

	it("divides the LLM error rate by the raw span population, not the netted volume", () => {
		// A mirrored call that failed twice reads above 100% against `llmCalls`.
		const row = measures({ llmCalls: 5, llmCallSpans: 10, erroredLlmCalls: 2 })
		expect(llmErrorRate(row)).toBe(0.2)
	})

	it("measures the cache hit ratio against everything that could have been a prompt read", () => {
		expect(cacheHitRatio(measures({ inputTokens: 30, cacheReadTokens: 70 }))).toBe(0.7)
	})
})

describe("tokenBandValues", () => {
	it("splits the five bands when they carry anything", () => {
		const bands = tokenBandValues(
			measures({
				tokens: 100,
				inputTokens: 40,
				cacheReadTokens: 30,
				cacheWriteTokens: 10,
				outputTokens: 15,
				reasoningTokens: 5,
			}),
		)
		expect(bands).toEqual({
			input: 40,
			cacheRead: 30,
			cacheWrite: 10,
			output: 15,
			reasoning: 5,
			total: 0,
		})
	})

	it("falls back to one band for a row materialized before the bucket columns", () => {
		const bands = tokenBandValues(measures({ tokens: 900 }))
		expect(bands.total).toBe(900)
		expect(bands.input).toBe(0)
	})

	it("leaves every band at zero when there are no tokens at all", () => {
		expect(tokenBandValues(EMPTY_OVERVIEW_MEASURES).total).toBe(0)
	})
})

describe("overviewDelta", () => {
	it("moves a rate in percentage points, never in percent", () => {
		const delta = overviewDelta(0.024, 0.26, { unit: "points", riseIs: "bad" })
		expect(delta?.pp).toBeCloseTo(23.6, 5)
		expect(delta?.percent).toBeNull()
		expect(delta?.text).toBe("+23.6pp")
		expect(delta?.tone).toBe("bad")
	})

	it("grades a fall in a rise-is-bad metric as good", () => {
		expect(overviewDelta(0.26, 0.024, { unit: "points", riseIs: "bad" })?.tone).toBe("good")
	})

	it("keeps a totals metric neutral in both directions", () => {
		expect(overviewDelta(100, 180, { unit: "percent", riseIs: "neutral" })?.tone).toBe("neutral")
		expect(overviewDelta(180, 100, { unit: "percent", riseIs: "neutral" })?.tone).toBe("neutral")
	})

	it("grades a rise in a rise-is-good metric as good", () => {
		expect(overviewDelta(0.12, 0.71, { unit: "points", riseIs: "good" })?.tone).toBe("good")
	})

	it("refuses a percentage against a window of zero", () => {
		expect(overviewDelta(0, 42, { unit: "percent", riseIs: "bad" })).toBeNull()
	})

	it("reads a move too small to matter as flat and neutral", () => {
		const delta = overviewDelta(0.2, 0.2001, { unit: "points", riseIs: "bad" })
		expect(delta?.direction).toBe("flat")
		expect(delta?.tone).toBe("neutral")
	})

	it("moves a duration by a duration and still reports its percent", () => {
		const delta = overviewDelta(96_000, 227_000, { unit: "duration", riseIs: "bad" })
		expect(delta?.absolute).toBe(131_000)
		expect(delta?.text).toBe("+2.2min")
		expect(delta?.percent).toBeCloseTo(1.3646, 3)
	})

	it("signs a fall", () => {
		expect(overviewDelta(200, 100, { unit: "percent", riseIs: "neutral" })?.text).toBe("-50%")
	})
})

describe("formatters", () => {
	it("prints counts in full up to a million and compacts past it", () => {
		expect(formatOverviewCount(1243)).toBe((1243).toLocaleString())
		expect(formatOverviewCount(2_400_000)).toBe("2.4M")
	})

	it("keeps a decimal on a per-session ratio while it has one to keep", () => {
		expect(formatPerSession(6.34)).toBe("6.3")
		expect(formatPerSession(420)).toBe((420).toLocaleString())
	})

	it("reads a zero duration as nothing measured rather than as 0μs", () => {
		expect(formatOverviewDuration(0)).toBe("—")
	})
})

describe("buildOverviewTiles", () => {
	const current = measures({
		sessions: 100,
		erroredSessions: 12,
		cost: 40,
		tokens: 1_000,
		toolCalls: 500,
		llmCallSpans: 200,
		pricedLlmCalls: 188,
		sessionDurationP50Ms: 40_000,
		sessionDurationP95Ms: 90_000,
	})
	const previous = measures({ sessions: 80, erroredSessions: 4, cost: 40, tokens: 800 })

	it("builds seven tiles in the strip's order", () => {
		expect(buildOverviewTiles(current, previous, { compare: true, windowLabel: "7d" }).map((t) => t.id)).toEqual([
			"sessions",
			"cost",
			"costPerSession",
			"tokens",
			"errorRate",
			"toolCallsPerSession",
			"durationP95",
		])
	})

	it("drops every delta when the comparison is off", () => {
		const tiles = buildOverviewTiles(current, previous, { compare: false, windowLabel: "7d" })
		expect(tiles.every((tile) => tile.delta === null)).toBe(true)
	})

	it("grades cost per session but leaves the cost total neutral", () => {
		const tiles = buildOverviewTiles(current, previous, { compare: true, windowLabel: "7d" })
		const byId = new Map(tiles.map((tile) => [tile.id, tile]))
		expect(byId.get("cost")?.delta?.tone).toBe("neutral")
		// $0.50 → $0.40 a session is an improvement even though the bill held.
		expect(byId.get("costPerSession")?.delta?.tone).toBe("good")
	})

	it("states the priced coverage under the cost tile", () => {
		const tiles = buildOverviewTiles(current, previous, { compare: true, windowLabel: "7d" })
		expect(tiles.find((tile) => tile.id === "cost")?.sub).toBe("priced 94%")
	})
})

describe("buildOverviewSeries", () => {
	it("derives every per-bucket reading and reads an empty bucket as zero", () => {
		const [busy, quiet] = buildOverviewSeries([
			{
				bucket: 1_000,
				...measures({
					sessions: 10,
					erroredSessions: 1,
					cost: 5,
					tokens: 1_000,
					inputTokens: 300,
					cacheReadTokens: 700,
					toolCalls: 40,
					erroredToolCalls: 4,
					llmCalls: 80,
					llmCallSpans: 100,
					erroredLlmCalls: 5,
					sessionDurationP50Ms: 1_000,
					sessionDurationP95Ms: 4_000,
				}),
			},
			{ bucket: 2_000, ...EMPTY_OVERVIEW_MEASURES },
		])
		expect(busy.costPerSession).toBe(0.5)
		expect(busy.tokensPerSession).toBe(100)
		expect(busy.toolCallsPerSession).toBe(4)
		expect(busy.llmCallsPerSession).toBe(8)
		expect(busy.sessionErrorRate).toBe(0.1)
		expect(busy.llmErrorRate).toBe(0.05)
		expect(busy.toolErrorRate).toBe(0.1)
		expect(busy.cacheHitRatio).toBe(0.7)
		expect(busy.sessionP95Ms).toBe(4_000)
		expect(busy.tokenBandShares.cacheRead).toBe(0.7)
		expect(busy.tokenBands.cacheRead).toBe(70)
		expect(Object.values(quiet.tokenBandShares).every((share) => share === 0)).toBe(true)
		expect(quiet.costPerSession).toBe(0)
	})
})

describe("shiftOverviewSeries", () => {
	it("moves the previous period onto the current period's axis", () => {
		const points = buildOverviewSeries([{ bucket: 100, ...EMPTY_OVERVIEW_MEASURES }])
		expect(shiftOverviewSeries(points, 900)[0].bucket).toBe(1_000)
	})
})

describe("buildModelMix", () => {
	const rows = [1, 2, 3, 4, 5, 6, 7].flatMap((rank) =>
		[0, 1].map((bucket) => ({
			bucket,
			model: `model-${rank}`,
			llmCallSpans: 100 - rank * 10,
		})),
	)

	it("keeps the five busiest models and folds the tail into one grey band", () => {
		const mix = buildModelMix(rows)
		expect(mix.models).toEqual([
			"model-1",
			"model-2",
			"model-3",
			"model-4",
			"model-5",
			"other",
		])
	})

	it("stacks each bucket to one", () => {
		const mix = buildModelMix(rows)
		for (const point of mix.points) {
			const total = mix.models.reduce((sum, model) => sum + point.shares[model], 0)
			expect(total).toBeCloseTo(1, 10)
		}
	})

	it("leaves out the other band when nothing was folded", () => {
		expect(buildModelMix([{ bucket: 0, model: "solo", llmCallSpans: 4 }]).models).toEqual(["solo"])
	})

	it("has no points and no models for a window that ran nothing", () => {
		expect(buildModelMix([])).toEqual({ models: [], points: [] })
	})
})

describe("buildBreakdownRows", () => {
	const entries = [
		{
			key: "opus",
			current: measures({ sessions: 100, erroredSessions: 10, cost: 60, tokens: 1_000, llmCalls: 200 }),
			previous: measures({ sessions: 80, erroredSessions: 4, cost: 40 }),
		},
		{
			key: "",
			current: measures({ sessions: 50, erroredSessions: 0, cost: 40, tokens: 500 }),
			previous: EMPTY_OVERVIEW_MEASURES,
		},
	]

	it("measures the cost share against the rows it is showing", () => {
		const rows = buildBreakdownRows("model", entries)
		expect(rows[0].shareOfCost).toBe(0.6)
		expect(rows[1].shareOfCost).toBe(0.4)
	})

	it("names the unattributed key rather than hiding it", () => {
		expect(buildBreakdownRows("model", entries)[1].label).toBe("Unattributed")
	})

	it("reports the session error rate for a usage dimension", () => {
		const rows = buildBreakdownRows("model", entries)
		expect(rows[0].errorRate).toBe(0.1)
		expect(rows[0].errorRateDeltaPp).toBeCloseTo(5, 5)
	})

	it("reports the CALL error rate for the tool dimension", () => {
		const rows = buildBreakdownRows("tool", [
			{
				key: "run_tests",
				current: measures({ sessions: 20, toolCalls: 100, erroredToolCalls: 28 }),
				previous: measures({ sessions: 20, toolCalls: 50, erroredToolCalls: 2 }),
			},
		])
		expect(rows[0].errorRate).toBe(0.28)
		expect(rows[0].errorRateDeltaPp).toBeCloseTo(24, 5)
	})

	it("has no move to show for a key the previous window never saw", () => {
		expect(buildBreakdownRows("model", entries)[1].errorRateDeltaPp).toBeNull()
	})
})

describe("buildMovers", () => {
	const quiet = {
		key: "quiet",
		current: measures({ sessions: 9, erroredSessions: 9 }),
		previous: measures({ sessions: 9 }),
	}
	const failing = {
		key: "opus",
		current: measures({ sessions: 100, llmCallSpans: 1_000, erroredLlmCalls: 161 }),
		previous: measures({ sessions: 100, llmCallSpans: 1_000, erroredLlmCalls: 19 }),
	}
	const pricier = {
		key: "gpt",
		current: measures({ sessions: 100, cost: 40 }),
		previous: measures({ sessions: 100, cost: 28 }),
	}

	it("drops a key too small to read in either window", () => {
		expect(buildMovers([{ dimension: "model", entries: [quiet] }])).toEqual([])
	})

	it("ranks a rate's points above a ratio's percent", () => {
		const movers = buildMovers([{ dimension: "model", entries: [failing, pricier] }])
		expect(movers.map((mover) => mover.key)).toEqual(["opus", "gpt"])
		expect(movers[0].metric).toBe("llmErrorRate")
		expect(movers[0].deltaText).toBe("+14.2pp")
		expect(movers[0].tone).toBe("bad")
	})

	it("keeps one line per key, its worst metric", () => {
		const both = {
			key: "opus",
			current: measures({ sessions: 100, cost: 80, llmCallSpans: 1_000, erroredLlmCalls: 161 }),
			previous: measures({ sessions: 100, cost: 40, llmCallSpans: 1_000, erroredLlmCalls: 19 }),
		}
		const movers = buildMovers([{ dimension: "model", entries: [both] }])
		expect(movers).toHaveLength(1)
		expect(movers[0].metric).toBe("llmErrorRate")
	})

	it("scores the tool error rate only under the tool dimension", () => {
		const entry = {
			key: "run_tests",
			current: measures({ sessions: 100, toolCalls: 100, erroredToolCalls: 28 }),
			previous: measures({ sessions: 100, toolCalls: 100, erroredToolCalls: 4 }),
		}
		expect(buildMovers([{ dimension: "tool", entries: [entry] }])[0]?.metric).toBe("toolErrorRate")
		// Under `model` the tool measures are structurally zero, so nothing ranks.
		expect(buildMovers([{ dimension: "model", entries: [entry] }])).toEqual([])
	})

	it("shows at most six lines however many dimensions moved", () => {
		const entries = Array.from({ length: 5 }, (_, index) => ({
			...failing,
			key: `key-${index}`,
		}))
		const movers = buildMovers([
			{ dimension: "model", entries },
			{ dimension: "agent", entries },
		])
		expect(movers).toHaveLength(OVERVIEW_MOVER_LIMIT)
	})
})

describe("overviewScopeSummary", () => {
	it("names the three populations the rest of the board divides by", () => {
		expect(
			overviewScopeSummary(measures({ sessions: 1_284, llmCalls: 10_842, toolCalls: 8_101 })),
		).toBe(
			`${(1284).toLocaleString()} sessions · ${(10842).toLocaleString()} LLM calls · ${(8101).toLocaleString()} tool calls`,
		)
	})
})

describe("buildAgentOverviewData", () => {
	const input = {
		current: measures({ sessions: 100, cost: 40, llmCallSpans: 100, pricedLlmCalls: 94 }),
		previous: measures({ sessions: 80, cost: 40 }),
		series: [{ bucket: 2_000, ...measures({ sessions: 10 }) }],
		previousSeries: [{ bucket: 1_000, ...measures({ sessions: 8 }) }],
		modelMix: [{ bucket: 2_000, model: "opus", llmCallSpans: 10 }],
		breakdowns: [{ dimension: "model" as const, entries: [], totalKeys: 3 }],
		bucketSeconds: 3_600,
		windowMs: { startMs: 2_000, endMs: 3_000 },
		windowLabel: "24h",
	}

	it("shifts the previous series onto the current window's axis", () => {
		const data = buildAgentOverviewData({ ...input, compare: true })
		expect(data.previousSeries[0].bucket).toBe(2_000)
	})

	it("drops the previous series entirely when the comparison is off", () => {
		expect(buildAgentOverviewData({ ...input, compare: false }).previousSeries).toEqual([])
	})

	it("builds nine charts and the priced coverage line", () => {
		const data = buildAgentOverviewData({ ...input, compare: true })
		expect(data.charts).toHaveLength(9)
		expect(data.coverage.share).toBe(0.94)
	})
})
