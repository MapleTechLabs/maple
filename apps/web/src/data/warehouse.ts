import { QueryEngineExecuteBatchRequest } from "@maple/domain/query-engine"
import { isBlipping, originOf } from "@maple/web-data/lib/peer-reachability"
import {
	ApiReachability,
	MapleApiV2Http,
	MapleInternalHttp,
	WarehouseExecutor,
} from "@maple/web-data/warehouse/warehouse-services"
import { Effect, Layer } from "effect"
import { apiBaseUrl } from "../platform/api-base-url"
import { MapleApiV2Client, MapleInternalApiClient } from "../platform/api-clients"
import { withResourceTiming } from "./resource-timing"
import { makeExecuteBatcher } from "./execute-batcher"

/**
 * `@maple/web-data`'s warehouse services over this app's clients. One instance per runtime, so
 * Commands on separate fibers share one batch window. Query functions (`@maple/web-data/warehouse/*`) run as Commands against it.
 */
const WarehouseExecutorLive = Layer.effect(
	WarehouseExecutor,
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const batcher = yield* makeExecuteBatcher((requests) =>
			client.queryEngine
				.executeBatch({ payload: new QueryEngineExecuteBatchRequest({ requests }) })
				.pipe(
					Effect.map((response) => response.results),
					withResourceTiming("/internal/query-engine/execute-batch"),
					Effect.withSpan("QueryEngine.executeBatch", {
						attributes: { "query.batch_size": requests.length },
					}),
				),
		)
		return { enqueue: batcher.enqueue, executeAlone: batcher.executeAlone }
	}),
)

/** The API origin's reachability clock, which the HTTP client keeps (`withRequestTimeout`). */
export const ApiReachabilityLive = Layer.succeed(ApiReachability, {
	isBlipping: (nowMs) => isBlipping(originOf(apiBaseUrl), nowMs),
})

export const WarehouseLive = Layer.mergeAll(
	WarehouseExecutorLive,
	ApiReachabilityLive,
	Layer.effect(MapleInternalHttp, Effect.service(MapleInternalApiClient)),
	Layer.effect(MapleApiV2Http, Effect.service(MapleApiV2Client)),
).pipe(Layer.provide([MapleInternalApiClient.layer, MapleApiV2Client.layer]))
