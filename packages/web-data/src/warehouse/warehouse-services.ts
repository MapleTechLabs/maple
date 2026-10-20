import type { MapleInternalApi } from "@maple/domain/http"
import type { MapleApiV2 } from "@maple/domain/http/v2"
import type { QueryEngineExecuteRequest, QueryEngineExecuteResponse } from "@maple/query-engine"
import { Context, type Effect } from "effect"
import type { HttpApiClient } from "effect/http-api"

/**
 * The services every warehouse query function needs. Each app provides them from its own
 * clients: apps/web from its resources.
 */

/** Joins one execute request to the app's shared execute-batch window. */
export class WarehouseExecutor extends Context.Service<
	WarehouseExecutor,
	{
		/** Fails with whatever the batch failed with; `executeQueryEngine` normalizes it. */
		readonly enqueue: (
			payload: QueryEngineExecuteRequest,
		) => Effect.Effect<QueryEngineExecuteResponse, unknown>
	}
>()("@maple/web-data/WarehouseExecutor") {}

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
