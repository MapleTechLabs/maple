import {
	type FacetItem,
	QueryEngineExecuteBatchRequest,
	type QueryEngineExecuteRequest,
	type QueryEngineExecuteResponse,
} from "@maple/query-engine"
import { Context, Effect, Layer } from "effect"
import { MapleInternalApiClient } from "../platform/api-clients"
import { makeExecuteBatcher } from "./execute-batcher"
import { failedWith, type WarehouseQueryError } from "./warehouse-error"

/**
 * The one way a query reaches the warehouse: every Command's query joins the process-wide
 * batcher, exactly as every apps/web atom does through `executeQueryEngine` (`effect-utils.ts`).
 * A resource, so the batcher (and its window) is shared by all Commands of the runtime.
 */
export class WarehouseExecutor extends Context.Service<
	WarehouseExecutor,
	{
		readonly execute: (
			operation: string,
			payload: QueryEngineExecuteRequest,
		) => Effect.Effect<QueryEngineExecuteResponse, WarehouseQueryError>
	}
>()("@maple/web-foldkit/WarehouseExecutor") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const batcher = yield* makeExecuteBatcher((requests) =>
				client.queryEngine
					.executeBatch({ payload: new QueryEngineExecuteBatchRequest({ requests }) })
					.pipe(
						Effect.map((response) => response.results),
						Effect.mapError((cause) => failedWith("QueryEngine.executeBatch", cause)),
						Effect.withSpan("QueryEngine.executeBatch", {
							attributes: { "query.batch_size": requests.length },
						}),
					),
			)
			return {
				execute: (operation, payload) =>
					batcher.execute(operation, payload).pipe(Effect.withSpan(operation)),
			}
		}),
	).pipe(Layer.provide(MapleInternalApiClient.layer))
}

// Typed result extractors, as `effect-utils.ts` has them.
export const extractFacets = (response: QueryEngineExecuteResponse): ReadonlyArray<FacetItem> =>
	response.result.kind === "facets" ? response.result.data : []
