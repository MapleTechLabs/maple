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
		const services = Context.make(WarehouseExecutor, yield* WarehouseExecutor).pipe(
			Context.add(MapleInternalHttp, yield* MapleInternalHttp),
			Context.add(MapleApiV2Http, yield* MapleApiV2Http),
		)
		return LogSource.of({
			listLogs: (request) =>
				listLogs({ data: request }).pipe(
					Effect.map((response) => response.data),
					Effect.mapError(toLoadFailure),
					Effect.provideContext(services),
				),
			traceSpans: ({ traceId, timestamp }) =>
				getSpanHierarchy({ data: { traceId, timestamp } }).pipe(
					Effect.map((response) => ({
						traceStartTime: response.traceStartTime ?? null,
						spanNames: response.spans.map((span) => ({ spanId: span.spanId, spanName: span.spanName })),
					})),
					Effect.mapError(toLoadFailure),
					Effect.provideContext(services),
				),
		})
	}),
)
