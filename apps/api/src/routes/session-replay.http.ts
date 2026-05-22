import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	GetReplayEventsResponse,
	GetReplayResponse,
	ListReplaysResponse,
	MapleApi,
	QueryEngineExecutionError,
	ReplaysForTraceResponse,
	TinybirdQueryError,
	TinybirdQuotaExceededError,
} from "@maple/domain/http"
import { Effect } from "effect"
import { CH } from "@maple/query-engine"
import { WarehouseQueryService } from "../services/WarehouseQueryService"
import { ReplayBlobStorage } from "../services/ReplayBlobStorage"

const isTaggedHttpError = (value: unknown): value is TinybirdQueryError | TinybirdQuotaExceededError =>
	value instanceof TinybirdQueryError || value instanceof TinybirdQuotaExceededError

const mapExecError = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	context: string,
): Effect.Effect<A, QueryEngineExecutionError | TinybirdQueryError | TinybirdQuotaExceededError, R> =>
	effect.pipe(
		Effect.mapError((cause) => {
			if (isTaggedHttpError(cause)) {
				return cause
			}
			return new QueryEngineExecutionError({
				message: context,
				causeMessage: cause instanceof Error ? cause.message : String(cause),
			})
		}),
	)

export const HttpSessionReplaysLive = HttpApiBuilder.group(MapleApi, "sessionReplays", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const replayBlobs = yield* ReplayBlobStorage

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
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "list",
							context: "listReplays",
						}),
						"listReplays query failed",
					)
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
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "discovery",
							context: "getReplay",
						}),
						"getReplay query failed",
					)
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
					const compiled = CH.compile(CH.sessionReplayChunksQuery(), {
						orgId: tenant.orgId,
						sessionId: payload.sessionId,
					})
					const chunks = compiled.castRows(
						yield* mapExecError(
							warehouse.sqlQuery(tenant, compiled.sql, {
								profile: "list",
								context: "getReplayEvents",
							}),
							"getReplayEvents query failed",
						),
					)
					const signed = yield* mapExecError(
						Effect.forEach(
							chunks,
							(chunk) =>
								replayBlobs
									.presignChunkUrl(tenant.orgId, payload.sessionId, chunk.chunkSeq)
									.pipe(Effect.map((url) => ({ ...chunk, url }))),
							{ concurrency: 8 },
						),
						"failed to presign replay chunks",
					)
					return new GetReplayEventsResponse({ chunks: signed })
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
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "list",
							context: "replaysForTrace",
						}),
						"replaysForTrace query failed",
					)
					return new ReplaysForTraceResponse({ data: compiled.castRows(rows) })
				}),
			)
	}),
)
