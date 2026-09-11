import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

import { AI_OVERVIEW_FILTER_VALUE_MAX_LENGTH, AiOverviewMeasures } from "@maple/domain/http"

import {
	AiOverviewBucketedInput,
	mapOverviewBreakdown,
	mapOverviewMeasures,
	mapOverviewModelMix,
	mapOverviewSeries,
	selectionFields,
} from "./ai-agent-overview"
import { WarehouseDecodeError, decodeInput } from "./effect-utils"

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
	...overrides,
})

describe("mapOverviewMeasures", () => {
	it("converts the session quantiles from nanoseconds to milliseconds", () => {
		const row = mapOverviewMeasures(wire())
		expect(row.sessionDurationP50Ms).toBe(42_000)
		expect(row.sessionDurationP95Ms).toBe(96_000)
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
		const [row] = mapOverviewBreakdown([{ key: "", current: wire(), previous: wire({ sessions: 4 }) }])
		expect(row.key).toBe("")
		expect(row.current.sessions).toBe(10)
		expect(row.previous.sessions).toBe(4)
	})
})

describe("mapOverviewModelMix", () => {
	it("reads the bucket as UTC and leaves the band alone", () => {
		// `other` is a band the read itself folds, and reaches the chart as the
		// key the client folds its own tail into.
		const rows = mapOverviewModelMix([
			{ bucket: "2026-09-10T18:00:00.000Z", model: "claude-opus-5", llmCallSpans: 42 },
			{ bucket: "2026-09-10T18:00:00.000Z", model: "other", llmCallSpans: 7 },
		])
		expect(rows[0].bucket).toBe(Date.UTC(2026, 8, 10, 18, 0, 0))
		expect(rows[0].model).toBe("claude-opus-5")
		expect(rows[0].llmCallSpans).toBe(42)
		expect(rows[1].model).toBe("other")
	})
})

/**
 * The local input schemas exist to mirror the domain request's bounds: a
 * violation has to land as a `WarehouseDecodeError` the page renders, because
 * the alternative is `new AiOverview*Request` throwing inside the read and
 * taking the page with it. A bound the mirror omits is exactly that defect.
 */
describe("the domain's bounds, mirrored", () => {
	const WINDOW = { startTime: "2026-09-10 00:00:00", endTime: "2026-09-10 03:00:00" }
	const bucketed = (overrides: Record<string, unknown> = {}) => ({
		...WINDOW,
		bucketSeconds: 300,
		...overrides,
	})

	const decode = (data: unknown) =>
		Effect.runSyncExit(decodeInput(AiOverviewBucketedInput, data, "aiOverviewSummary"))

	const failure = (data: unknown) =>
		Effect.runSync(Effect.flip(decodeInput(AiOverviewBucketedInput, data, "aiOverviewSummary")))

	it("takes the board's own selection", () => {
		expect(Exit.isSuccess(decode(bucketed({ model: "claude-opus-5", hasErrors: true })))).toBe(true)
	})

	it("fails typed for a filter value past the contract's per-value cap", () => {
		const error = failure(bucketed({ model: "m".repeat(AI_OVERVIEW_FILTER_VALUE_MAX_LENGTH + 1) }))
		expect(error).toBeInstanceOf(WarehouseDecodeError)
		expect(error.operation).toBe("aiOverviewSummary")
		// One character under it is a value the contract accepts.
		expect(
			Exit.isSuccess(decode(bucketed({ model: "m".repeat(AI_OVERVIEW_FILTER_VALUE_MAX_LENGTH) }))),
		).toBe(true)
	})

	it("fails typed for a datetime the pattern admits and the calendar does not", () => {
		expect(failure(bucketed({ startTime: "2026-13-45 99:99:99" }))).toBeInstanceOf(WarehouseDecodeError)
	})

	it("fails typed for an inverted window", () => {
		expect(
			failure({ startTime: WINDOW.endTime, endTime: WINDOW.startTime, bucketSeconds: 300 }),
		).toBeInstanceOf(WarehouseDecodeError)
	})
})

describe("selectionFields", () => {
	const WINDOW = { startTime: "2026-09-10 00:00:00", endTime: "2026-09-10 03:00:00" }

	it("widens each single value into the array-valued key the contract takes", () => {
		expect(
			selectionFields({
				...WINDOW,
				framework: "eve",
				service: "api",
				environment: "prd",
				model: "claude-opus-5",
				agent: "captain",
				tool: "run_tests",
				hasErrors: true,
			}),
		).toEqual({
			vendorIds: ["eve"],
			serviceNames: ["api"],
			deploymentEnvs: ["prd"],
			models: ["claude-opus-5"],
			agentNames: ["captain"],
			toolNames: ["run_tests"],
			hasErrors: true,
		})
	})

	it("omits the key a dimension has no value for, rather than sending an empty array", () => {
		// An explicit `undefined` is not an absent key on the wire, and an empty
		// `IN ()` list selects nothing rather than everything.
		expect(selectionFields(WINDOW)).toEqual({})
		expect(selectionFields({ ...WINDOW, model: "claude-opus-5" })).toEqual({
			models: ["claude-opus-5"],
		})
		expect(selectionFields({ ...WINDOW, hasErrors: false })).toEqual({ hasErrors: false })
	})
})
