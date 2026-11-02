import { LogSource } from "@maple/views/logs/log-source"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { listLogs } from "@maple/web-data/warehouse/logs"
import { getSpanHierarchy } from "@maple/web-data/warehouse/traces"
import {
	MapleApiV2Http,
	MapleInternalHttp,
	WarehouseExecutor,
} from "@maple/web-data/warehouse/warehouse-services"
import { Context, Effect, Layer } from "effect"

// The log views' reads over the API: `listLogs` and `getSpanHierarchy`, on the warehouse services.

export const LogSourceLive = Layer.effect(
	LogSource,
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const internalHttp = yield* MapleInternalHttp
		const apiV2Http = yield* MapleApiV2Http
		const services = Context.make(WarehouseExecutor, executor).pipe(
			Context.add(MapleInternalHttp, internalHttp),
			Context.add(MapleApiV2Http, apiV2Http),
		)
		return LogSource.of({
			listLogs: (request) =>
				listLogs({ data: request }).pipe(
					Effect.mapBoth({
						onSuccess: (response) => response.data,
						onFailure: toLoadFailure,
					}),
					Effect.provideContext(services),
				),
			traceSpans: ({ traceId, timestamp }) =>
				getSpanHierarchy({ data: { traceId, timestamp } }).pipe(
					Effect.mapBoth({
						onSuccess: (response) => ({
							traceStartTime: response.traceStartTime ?? null,
							spanNames: response.spans.map((span) => ({ spanId: span.spanId, spanName: span.spanName })),
						}),
						onFailure: toLoadFailure,
					}),
					Effect.provideContext(services),
				),
		})
	}),
)
