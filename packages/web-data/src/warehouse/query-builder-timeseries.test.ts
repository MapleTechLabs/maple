// TEST-SEAM: `executeQueryEngine` is this module's network boundary; the tests answer it in memory.
import { Array as Arr, Effect, Exit } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createQueryDraft } from "@maple/query-engine/query-builder"
import { mockedWarehouse } from "./testing"

const executeQueryEngineMock = vi.fn()

vi.mock("./effect-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("./effect-utils")>()),
	executeQueryEngine: (...args: ReadonlyArray<unknown>) => executeQueryEngineMock(...args),
}))

import { WarehouseQueryError } from "./effect-utils"
import { getQueryBuilderTimeseries, type QueryBuilderTimeseriesInput } from "./query-builder-timeseries"

const START = "2026-01-01 00:00:00"
const END = "2026-01-01 01:00:00"

const run = (data: Omit<QueryBuilderTimeseriesInput, "startTime" | "endTime" | "queries">) =>
	Effect.runPromiseExit(
		mockedWarehouse(
			getQueryBuilderTimeseries({
				data: { startTime: START, endTime: END, queries: [createQueryDraft(1)], ...data },
			}),
		),
	)

/** The windows the warehouse was asked for, as `start|end`. */
const requestedWindows = () =>
	new Set(
		Arr.map(executeQueryEngineMock.mock.calls, (call) => {
			const payload: { startTime: string; endTime: string } = call[1]
			return `${payload.startTime}|${payload.endTime}`
		}),
	)

beforeEach(() => {
	executeQueryEngineMock.mockReset()
	executeQueryEngineMock.mockImplementation(() =>
		Effect.succeed({ result: { kind: "timeseries", data: [] } }),
	)
})

/**
 * An empty window used to fail with `WarehouseInvalidInputError`, which marked
 * the span `Error` and billed an exception event per tile per refresh (24 in 20
 * minutes from one user paging a quiet dashboard). It is an answer now, and
 * every caller already renders zero rows as its own empty state.
 */
describe("empty window", () => {
	it("answers with zero rows and diagnostics describing the requested window", async () => {
		const exit = await run({
			comparison: { mode: "previous_period" },
			strategy: { enableEmptyRangeFallback: false },
		})

		expect(exit).toStrictEqual(
			Exit.succeed({
				data: [],
				diagnostics: {
					primaryWindow: { startTime: START, endTime: END },
					comparison: {
						mode: "previous_period",
						includePercentChange: true,
						shiftedByMs: 0,
						previousStartTime: null,
						previousEndTime: null,
					},
					queries: [],
					previousQueries: [],
				},
			}),
		)
	})

	it("still fails when a query itself failed", async () => {
		executeQueryEngineMock.mockImplementation(() =>
			Effect.fail(
				new WarehouseQueryError({ operation: "queryEngine.timeseriesQuery", message: "boom" }),
			),
		)

		const exit = await run({ strategy: { enableEmptyRangeFallback: false } })

		expect(Exit.isFailure(exit)).toBe(true)
	})
})

describe("empty-range fallback (wire strategy)", () => {
	/**
	 * `use-widget-data` sends `enableEmptyRangeFallback: false` on every dashboard
	 * tile. If that stopped disabling the ladder, an empty tile would silently
	 * start charting data from outside its own time range.
	 */
	it("never widens the window for the dashboard tile's explicit opt-out", async () => {
		await run({ strategy: { enableEmptyRangeFallback: false } })

		expect(requestedWindows()).toEqual(new Set([`${START}|${END}`]))
	})

	it("widens an empty window by the caller's own ladder, never narrower or past its ceiling", async () => {
		await run({
			strategy: {
				enableEmptyRangeFallback: true,
				fallbackWindowSeconds: [7200, 60, 172_800],
				maxFallbackRangeSeconds: 86_400,
			},
		})

		expect(requestedWindows()).toEqual(new Set([`${START}|${END}`, `2025-12-31 23:00:00|${END}`]))
	})

	it("falls back to the lab ladder (a day, a week, a month) when the caller sends no strategy", async () => {
		await run({})

		expect(requestedWindows()).toEqual(
			new Set([
				`${START}|${END}`,
				`2025-12-31 01:00:00|${END}`,
				`2025-12-25 01:00:00|${END}`,
				`2025-12-01 01:00:00|${END}`,
			]),
		)
	})
})
