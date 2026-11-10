// TEST-SEAM: `executeQueryEngine` is this module's network boundary; the tests answer it in memory.
import { Effect, Exit } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createQueryDraft } from "@maple/query-engine/query-builder"
import { mockedWarehouse } from "./testing"

const executeQueryEngineMock = vi.fn()

vi.mock("./effect-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("./effect-utils")>()),
	executeQueryEngine: (...args: ReadonlyArray<unknown>) => executeQueryEngineMock(...args),
}))

import { WarehouseQueryError } from "./effect-utils"
import { getQueryBuilderBreakdown } from "./query-builder-breakdown"

const run = () =>
	Effect.runPromiseExit(
		mockedWarehouse(
			getQueryBuilderBreakdown({
				data: {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 01:00:00",
					queries: [createQueryDraft(1)],
				},
			}),
		),
	)

beforeEach(() => {
	executeQueryEngineMock.mockReset()
	executeQueryEngineMock.mockImplementation(() =>
		Effect.succeed({ result: { kind: "breakdown", data: [] } }),
	)
})

/**
 * The timeseries adapter stopped failing on an empty window (an empty window is
 * a normal answer) but the breakdown adapter beside it was left raising
 * `WarehouseInvalidInputError`, which marked the span `Error` and billed an
 * exception event for a panel the user simply has no data for.
 */
describe("empty window", () => {
	it("answers with zero rows when every query ran and none matched", async () => {
		expect(await run()).toStrictEqual(Exit.succeed({ data: [] }))
	})

	it("still fails when a query itself failed", async () => {
		executeQueryEngineMock.mockImplementation(() =>
			Effect.fail(
				new WarehouseQueryError({ operation: "queryEngine.breakdownQuery", message: "boom" }),
			),
		)

		expect(Exit.isFailure(await run())).toBe(true)
	})
})
