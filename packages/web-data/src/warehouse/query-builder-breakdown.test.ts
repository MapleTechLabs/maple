import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

import { QuerySetNoDataError } from "@maple/query-engine/query-set"
import * as breakdownModule from "./query-builder-breakdown"

/**
 * The timeseries adapter stopped failing on an empty window — an empty window is
 * a normal answer — but the breakdown adapter beside it was left raising
 * `WarehouseInvalidInputError`, which marked the span `Error` and billed an
 * exception event for a panel the user simply has no data for.
 */
describe("empty window", () => {
	it("answers with zero rows when every query ran and none matched", () => {
		const exit = Effect.runSyncExit(
			breakdownModule.__testables.onNoData(
				new QuerySetNoDataError({
					message: "No breakdown data found in selected time range",
					details: [],
				}),
			),
		)

		expect(exit).toStrictEqual(Exit.succeed({ rows: [], diagnostics: [] }))
	})

	it("still fails when a query itself failed", () => {
		const exit = Effect.runSyncExit(
			breakdownModule.__testables.onNoData(
				new QuerySetNoDataError({
					message: "Unknown column 'nope'",
					details: ["Unknown column 'nope'"],
				}),
			),
		)

		expect(Exit.isFailure(exit)).toBe(true)
	})
})
