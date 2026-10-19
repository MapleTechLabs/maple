import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

import { QuerySetNoDataError } from "@maple/query-engine/query-set"
import * as breakdownModule from "@/api/warehouse/query-builder-breakdown"
import { makeWarehouseExecutor, recordingFailureTitle } from "@/api/warehouse/query-set-executor"
import {
	GcpLiveQueryRejectedError,
	GcpLiveQueryUnavailableError,
} from "@maple/domain/http/gcp-live-query-errors"
import { displayError } from "@/lib/error-messages"

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

describe("a failed query's title", () => {
	it("titles the chart error with the reported failure's own title", async () => {
		const run = recordingFailureTitle(makeWarehouseExecutor("test"))
		// The runner describes each failed query as text; the reported text picks the title.
		run.executor.describeError(
			new GcpLiveQueryRejectedError({
				message: "Label region cannot be compared with gt.",
				reason: "invalid_query",
			}),
		)
		const unavailable = "Connect Google Cloud with metrics on to query Google Cloud metrics."
		run.executor.describeError(new GcpLiveQueryUnavailableError({ message: unavailable }))
		const error = await Effect.runPromise(
			Effect.flip(
				breakdownModule.__testables.onNoData(
					new QuerySetNoDataError({ message: unavailable, details: [unavailable] }),
					run.failureTitle(unavailable),
				),
			),
		)
		expect(displayError(error).title).toBe("Google Cloud metrics are not available")
	})
})
