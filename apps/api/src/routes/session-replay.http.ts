import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	GetReplayEventsResponse,
	GetReplayResponse,
	ListReplaysResponse,
	MapleApi,
	ReplaysForTraceResponse,
	SessionTraceSummariesResponse,
} from "@maple/domain/http"
import { Effect } from "effect"
import { CH } from "@maple/query-engine"
import { WarehouseQueryService } from "../services/WarehouseQueryService"

export const HttpSessionReplaysLive = HttpApiBuilder.group(MapleApi, "sessionReplays", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService

		return handlers
			.handle("listReplays", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ "maple.org_id": tenant.orgId })
					const compiled = CH.compile(
						CH.sessionReplaysListQuery({
							serviceName: payload.serviceName,
							browser: payload.browser,
							country: payload.country,
							deviceType: payload.deviceType,
							hasErrors: payload.hasErrors,
							search: payload.search,
							cursor: payload.cursor,
							limit: payload.limit,
							offset: payload.offset,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* warehouse.sqlQuery(tenant, compiled.sql, {
						profile: "list",
						context: "listReplays",
					})
					return new ListReplaysResponse({ data: compiled.castRows(rows) })
				}),
			)
			.handle("getReplay", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						"maple.org_id": tenant.orgId,
						"maple.session.id": payload.sessionId,
					})
					const compiled = CH.compile(CH.getSessionReplayQuery(), {
						orgId: tenant.orgId,
						sessionId: payload.sessionId,
					})
					const rows = yield* warehouse.sqlQuery(tenant, compiled.sql, {
						profile: "discovery",
						context: "getReplay",
					})
					return new GetReplayResponse({ data: compiled.castRows(rows)[0] ?? null })
				}),
			)
			.handle("getReplayEvents", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						"maple.org_id": tenant.orgId,
						"maple.session.id": payload.sessionId,
					})
					const compiled = CH.compile(CH.sessionReplayEventsQuery(), {
						orgId: tenant.orgId,
						sessionId: payload.sessionId,
					})
					const chunks = compiled.castRows(
						yield* warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "list",
							context: "getReplayEvents",
						}),
					)
					// rrweb payloads come straight from ClickHouse (no R2 / presigning);
					// each chunk's `events` is the rrweb array JSON the player parses.
					return new GetReplayEventsResponse({ chunks })
				}),
			)
			.handle("replaysForTrace", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						"maple.org_id": tenant.orgId,
						"maple.trace.id": payload.traceId,
					})
					const compiled = CH.compile(CH.sessionsForTraceQuery({ traceId: payload.traceId }), {
						orgId: tenant.orgId,
						startTime: payload.startTime,
						endTime: payload.endTime,
					})
					const rows = yield* warehouse.sqlQuery(tenant, compiled.sql, {
						profile: "list",
						context: "replaysForTrace",
					})
					return new ReplaysForTraceResponse({ data: compiled.castRows(rows) })
				}),
			)
			.handle("traceSummaries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						"maple.org_id": tenant.orgId,
						"maple.trace.count": payload.traceIds.length,
					})
					// `TraceId IN ()` is invalid SQL; a session with no correlated traces
					// short-circuits to an empty result without touching the warehouse.
					if (payload.traceIds.length === 0) {
						return new SessionTraceSummariesResponse({ data: [] })
					}
					const compiled = CH.compile(
						CH.sessionTraceSummariesQuery({ traceIds: payload.traceIds }),
						{ orgId: tenant.orgId },
					)
					const rows = yield* warehouse.sqlQuery(tenant, compiled.sql, {
						profile: "list",
						context: "sessionTraceSummaries",
					})
					return new SessionTraceSummariesResponse({ data: compiled.castRows(rows) })
				}),
			)
	}),
)
