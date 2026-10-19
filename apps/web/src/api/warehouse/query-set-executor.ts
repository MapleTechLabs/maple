import { Effect } from "effect"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import type { QuerySetExecutor } from "@maple/query-engine/query-set"
import {
	decodeInput,
	executeQueryEngine,
	type BackendError,
	type WarehouseApiError,
} from "@/api/warehouse/effect-utils"
import { displayError } from "@/lib/error-messages"

export type QuerySetExecuteError = WarehouseApiError | BackendError

/**
 * The browser's `QuerySetExecutor`: one `QuerySpec` over one window, via HTTP.
 *
 * `executeQueryEngine` enqueues onto a per-tick batcher that coalesces every
 * request made in the same tick into a single `POST /execute-batch`. That is why
 * the runners fan out at full concurrency instead of bounding themselves — see
 * the note on `runQuerySetWindow`.
 *
 * Takes the operation label rather than hard-coding one: it lands on the span as
 * `query.operation`, and collapsing the three shapes into a single name would
 * make the existing traces harder to read for no gain.
 */
export const makeWarehouseExecutor = (operation: string): QuerySetExecutor<QuerySetExecuteError> => ({
	execute: (request) =>
		Effect.gen(function* () {
			const decoded = yield* decodeInput(
				QueryEngineExecuteRequest,
				{ startTime: request.startTime, endTime: request.endTime, query: request.query },
				`${operation}.request`,
			)
			const response = yield* executeQueryEngine(operation, decoded)
			return response.result
		}),
	describeError: (error) => displayError(error).message,
})

/**
 * `executor` for one run that remembers each failure's own title. The runner reports a failed
 * query as text; `failureTitle(reported)` gives the title of the failure that text came from, so
 * the chart's error card says e.g. "Google Cloud metrics are not available", not "Invalid query".
 */
export const recordingFailureTitle = (executor: QuerySetExecutor<QuerySetExecuteError>) => {
	const failures: Array<{ readonly message: string; readonly title: string }> = []
	return {
		executor: {
			...executor,
			describeError: (error: QuerySetExecuteError) => {
				const message = executor.describeError(error)
				failures.push({ message, title: displayError(error).title })
				return message
			},
		} satisfies QuerySetExecutor<QuerySetExecuteError>,
		failureTitle: (reported: string) =>
			failures.find((failure) => reported.includes(failure.message))?.title,
	}
}
