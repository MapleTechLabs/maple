import { Effect } from "effect"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import type { QuerySetExecutor } from "@maple/query-engine/query-set"
import { decodeInput, executeQueryEngine, type BackendError, type WarehouseApiError } from "./effect-utils"
import { WarehouseExecutor } from "./warehouse-services"
import { displayError } from "../lib/error-messages"

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
 * make the existing traces harder to read for no gain. The port takes no services, so the
 * app's `WarehouseExecutor` is captured when the executor is made.
 */
export const makeWarehouseExecutor = (
	operation: string,
): Effect.Effect<QuerySetExecutor<QuerySetExecuteError>, never, WarehouseExecutor> =>
	Effect.map(Effect.context<WarehouseExecutor>(), (context) => ({
		execute: (request) =>
			Effect.gen(function* () {
				const decoded = yield* decodeInput(
					QueryEngineExecuteRequest,
					{ startTime: request.startTime, endTime: request.endTime, query: request.query },
					`${operation}.request`,
				)
				const response = yield* executeQueryEngine(operation, decoded)
				return response.result
			}).pipe(Effect.provide(context)),
		describeError: (error) => displayError(error).message,
	}))
