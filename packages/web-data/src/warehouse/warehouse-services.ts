import type { MapleInternalApi } from "@maple/domain/http"
import type { MapleApiV2 } from "@maple/domain/http/v2"
import type {
	QueryEngineBatchFailure,
	QueryEngineExecuteRequest,
	QueryEngineExecuteResponse,
} from "@maple/domain/query-engine"
import { Context, Effect, Schema } from "effect"
import type { HttpApiClient } from "effect/http-api"

/**
 * The services every warehouse query function needs. Each app provides them from its own
 * clients: apps/web from its resources.
 */

/** A batch response with fewer outcomes than queries. */
export class MissingBatchResultError extends Schema.TaggedError<MissingBatchResultError>()(
	"@maple/web-data/MissingBatchResultError",
	{ message: Schema.String },
) {}

type ExecuteBatchCall = HttpApiClient.ForApi<typeof MapleInternalApi>["queryEngine"]["executeBatch"]

/** One enqueued query's failure: the whole batch request's, or its own positional outcome. */
export type WarehouseExecuteFailure =
	| Effect.Error<ReturnType<ExecuteBatchCall>>
	| QueryEngineBatchFailure
	| MissingBatchResultError

/** Joins one execute request to the app's shared execute-batch window. */
export class WarehouseExecutor extends Context.Service<
	WarehouseExecutor,
	{
		/** `executeQueryEngine` normalizes the failure into a warehouse error. */
		readonly enqueue: (
			payload: QueryEngineExecuteRequest,
		) => Effect.Effect<QueryEngineExecuteResponse, WarehouseExecuteFailure>
		/** Skips the shared window: the query goes out at once in its own request. */
		readonly executeAlone: (
			payload: QueryEngineExecuteRequest,
		) => Effect.Effect<QueryEngineExecuteResponse, WarehouseExecuteFailure>
	}
>()("@maple/web-data/WarehouseExecutor") {}

/**
 * Runs `effect` with its warehouse reads in their own request instead of the shared batch.
 * A batch answers at the speed of its slowest member, so use it for a read that can be slow.
 */
export const outsideSharedBatch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.updateService(effect, WarehouseExecutor, (executor) => ({
		...executor,
		enqueue: executor.executeAlone,
	}))

/** The plain typed client of the dashboard's private `/internal` API. */
export class MapleInternalHttp extends Context.Service<
	MapleInternalHttp,
	HttpApiClient.ForApi<typeof MapleInternalApi>
>()("@maple/web-data/MapleInternalHttp") {}

/** The plain typed client of the public v2 API. */
export class MapleApiV2Http extends Context.Service<
	MapleApiV2Http,
	HttpApiClient.ForApi<typeof MapleApiV2>
>()("@maple/web-data/MapleApiV2Http") {}

/**
 * Whether the API origin is inside a short run of transport failures (a network blip, see
 * `lib/peer-reachability.ts`). Defaults to never, for an app that does not track reachability.
 */
export const ApiReachability = Context.Reference<{ readonly isBlipping: (nowMs: number) => boolean }>(
	"@maple/web-data/ApiReachability",
	{ defaultValue: () => ({ isBlipping: () => false }) },
)

export type WarehouseServices = WarehouseExecutor | MapleInternalHttp | MapleApiV2Http
