import { DateTime, Effect, Schema } from "effect"
import {
	ProductEventsForTraceRequest,
	ProductEventsForTraceResponse,
	ServiceName,
	SpanDetailRequest,
	SpanDetailResponse,
	SpanHierarchyRequest,
	SpanHierarchyResponse,
	SpanId,
	SpanName,
	TraceId,
	TraceSpanEventsRequest,
	TraceSpanEventsResponse,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { CH, formatWarehouseDateTime, parseSpanEvents } from "@maple/query-engine"
import { defineQuery, Queries } from "@maple/query-engine/registry"
import type { EndpointHandler } from "../../fixtures/dataset.ts"
import type { FixtureWarehouse } from "../warehouse.ts"
import { coerceStatusCode, partitionWindowAround, warehouseEndpoint } from "./run.ts"

/**
 * The trace endpoints of `HttpQueryEngineLive`. `spanDetail`, `spanEvents` and `traceSpanEvents`
 * are app-side definitions in apps/api/src/routes/queries.ts, restated here with the same CH
 * query and params; caching is irrelevant to the fixture, so their policies are dropped.
 */

const spanDetail = defineQuery({
	id: "spanDetail",
	profile: "discovery",
	cache: undefined,
	compile: (payload: SpanDetailRequest, orgId: OrgId) => {
		const narrowByTime = payload.startTime != null && payload.endTime != null
		return CH.compile(
			CH.spanDetailQuery({ traceId: payload.traceId, spanId: payload.spanId, narrowByTime }),
			narrowByTime ? { orgId, startTime: payload.startTime, endTime: payload.endTime } : { orgId },
		)
	},
})

interface SpanEventsKey {
	readonly traceId: string
	readonly spanId: string
	readonly serviceName: string
	readonly spanName: string
	readonly startTime: string
	readonly endTime: string
}

const spanEvents = defineQuery({
	id: "spanEvents",
	profile: "discovery",
	cache: undefined,
	compile: (payload: SpanEventsKey, orgId: OrgId) =>
		CH.compile(
			CH.spanEventsQuery({
				traceId: payload.traceId,
				spanId: payload.spanId,
				serviceName: payload.serviceName,
				spanName: payload.spanName,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

const traceSpanEvents = defineQuery({
	id: "traceSpanEvents",
	profile: "list",
	cache: undefined,
	compile: (payload: TraceSpanEventsRequest, orgId: OrgId) =>
		CH.compile(CH.spanEventsByTraceQuery({ traceId: payload.traceId }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const decodeTraceId = Schema.decodeSync(TraceId)
const decodeSpanId = Schema.decodeSync(SpanId)
const decodeServiceName = Schema.decodeUnknownSync(ServiceName)
const decodeSpanName = Schema.decodeUnknownSync(SpanName)

/** `PROBE_RECENT_WINDOW_MS`: probe the last 48 h before every partition. */
const PROBE_RECENT_WINDOW_MS = 48 * 3_600_000

export const traceEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.spanHierarchy": warehouseEndpoint(
		warehouse,
		SpanHierarchyRequest,
		SpanHierarchyResponse,
		(payload, { runQuery, runQueryFirst, nowMs }) =>
			Effect.gen(function* () {
				// Without a window, a LIMIT-1 probe (recent partitions first) finds the trace's day.
				const probe =
					payload.startTime != null && payload.endTime != null
						? null
						: ((yield* runQueryFirst(Queries.spanHierarchyProbeRecent, {
								traceId: payload.traceId,
								startTime: formatWarehouseDateTime(nowMs - PROBE_RECENT_WINDOW_MS),
							})) ?? (yield* runQueryFirst(Queries.spanHierarchyProbe, payload)))
				const window =
					probe?.timestamp == null
						? { startTime: payload.startTime, endTime: payload.endTime }
						: partitionWindowAround(DateTime.formatIso(probe.timestamp))
				const rows = yield* runQuery(Queries.spanHierarchy, {
					traceId: payload.traceId,
					spanId: payload.spanId,
					...window,
				})
				return new SpanHierarchyResponse({
					data: rows.map((row) => ({
						...row,
						startTime: DateTime.formatIso(row.startTime),
						traceId: decodeTraceId(row.traceId),
						spanId: decodeSpanId(row.spanId),
						spanName: decodeSpanName(row.spanName),
						serviceName: decodeServiceName(row.serviceName),
						statusCode: coerceStatusCode(row.statusCode),
					})),
				})
			}),
	),
	"queryEngine.spanDetail": warehouseEndpoint(
		warehouse,
		SpanDetailRequest,
		SpanDetailResponse,
		(payload, { runQueryFirst }) =>
			Effect.gen(function* () {
				const row = yield* runQueryFirst(spanDetail, payload)
				if (row === null) return new SpanDetailResponse({ data: null })
				const startMs = DateTime.toEpochMillis(row.startTime)
				const events = yield* runQueryFirst(spanEvents, {
					traceId: row.traceId,
					spanId: row.spanId,
					serviceName: row.serviceName,
					spanName: row.rawSpanName,
					startTime: formatWarehouseDateTime(startMs),
					endTime: formatWarehouseDateTime(startMs + 1000),
				}).pipe(
					Effect.map((raw) => (raw ? parseSpanEvents(raw) : [])),
					Effect.orElseSucceed(() => []),
				)
				return new SpanDetailResponse({
					data: {
						traceId: decodeTraceId(row.traceId),
						spanId: decodeSpanId(row.spanId),
						spanAttributes: row.spanAttributes,
						resourceAttributes: row.resourceAttributes,
						events,
					},
				})
			}),
	),
	"queryEngine.traceSpanEvents": warehouseEndpoint(
		warehouse,
		TraceSpanEventsRequest,
		TraceSpanEventsResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(traceSpanEvents, payload),
				(rows) =>
					new TraceSpanEventsResponse({
						data: rows.flatMap((row) => {
							const events = parseSpanEvents(row).map(({ name, offsetMs }) => ({
								name,
								offsetMs,
							}))
							return events.length === 0 ? [] : [{ spanId: decodeSpanId(row.spanId), events }]
						}),
					}),
			),
	),
	"queryEngine.productEventsForTrace": warehouseEndpoint(
		warehouse,
		ProductEventsForTraceRequest,
		ProductEventsForTraceResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.productEventsForTrace, payload),
				(rows) =>
					new ProductEventsForTraceResponse({
						data: rows.map((row) => ({
							timestamp: DateTime.formatIso(row.timestamp),
							eventName: row.eventName,
							spanId: row.spanId,
							serviceName: row.serviceName,
							userId: row.userId,
							groupId: row.groupId,
							visitorId: row.visitorId,
							sessionId: row.sessionId,
							attributes: row.attributes,
						})),
					}),
			),
	),
})
