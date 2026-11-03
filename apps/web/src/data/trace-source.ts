import { toLoadFailure } from "@maple/views/data/load-failure"
import { TraceSource } from "@maple/views/traces/trace-source"
import { listLogs } from "@maple/web-data/warehouse/logs"
import { getSpanDetail } from "@maple/web-data/warehouse/traces"
import {
	MapleApiV2Http,
	MapleInternalHttp,
	WarehouseExecutor,
} from "@maple/web-data/warehouse/warehouse-services"
import { Context, Effect, Layer, Option, Array as Arr } from "effect"

// The trace views' reads over the API: `getSpanDetail` and `listLogs`, on the warehouse services.

export const TraceSourceLive = Layer.effect(
	TraceSource,
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const internalHttp = yield* MapleInternalHttp
		const apiV2Http = yield* MapleApiV2Http
		const services = Context.make(WarehouseExecutor, executor).pipe(
			Context.add(MapleInternalHttp, internalHttp),
			Context.add(MapleApiV2Http, apiV2Http),
		)
		return TraceSource.of({
			spanDetail: ({ traceId, spanId, timestamp }) =>
				getSpanDetail({ data: { traceId, spanId, timestamp } }).pipe(
					// An unknown span reads as empty maps, as the panel always showed it.
					Effect.mapBoth({
						onSuccess: (detail) =>
							Option.some({
								spanAttributes: detail.spanAttributes,
								resourceAttributes: detail.resourceAttributes,
								events: detail.events,
							}),
						onFailure: toLoadFailure,
					}),
					Effect.provideContext(services),
				),
			spanLogs: ({ traceId, spanId, limit }) =>
				listLogs({ data: { traceId, spanId, limit } }).pipe(
					Effect.mapBoth({
						onSuccess: (response) =>
							Arr.map(response.data, (log, index) => ({
								key: `${index}:${log.timestamp}`,
								timestamp: log.timestamp,
								severityText: log.severityText,
								body: log.body,
							})),
						onFailure: toLoadFailure,
					}),
					Effect.provideContext(services),
				),
		})
	}),
)
