import { DateTime, Effect, Option, Schema } from "effect"
import { ReplayBlobStore } from "@maple/backend/platform/ReplayBlobStore"
import { SessionReplayReadService } from "@maple/backend/services/session-replays/SessionReplayReadService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	ReplaysFacetsRequest,
	ReplaysFacetsResponse,
	SessionTraceSummariesRequest,
	SessionTraceSummariesResponse,
	TraceId,
} from "@maple/domain/http"
import {
	encodePublicId,
	LIST_LIMIT_DEFAULT,
	MAX_REPLAY_CHUNKS_PER_REQUEST,
	MAX_REPLAY_MANIFEST_CHUNKS,
	MAX_REPLAY_RANGE_PAYLOAD_BYTES,
	paginateOffsetQuery,
	PublicIdPrefixes,
	V2SessionReplayNotFound,
	V2SessionReplaySearchParams,
} from "@maple/domain/http/v2"
import { sessionTagsOf } from "@maple/domain/query-engine"
import { parseUtc } from "@maple/query-engine"
import { tenantFor } from "../../../backend/middleware.ts"
import type { FixtureWarehouse } from "../../../backend/warehouse.ts"
import type { Dataset, EndpointHandler } from "../../dataset.ts"
import { epochMs, num, str } from "./synthetic.ts"

/**
 * Session replay reads: the real `SessionReplayReadService` over the fixture warehouse (no blob
 * bucket, so chunks are served inline as self-hosted does) and the v2 / internal handlers' shaping.
 */

const decodeTraceId = Schema.decodeSync(TraceId)
const publicId = (sessionId: string) => encodePublicId(PublicIdPrefixes.sessionReplay, sessionId)
const isSearch = Schema.is(V2SessionReplaySearchParams)
const isFacets = Schema.is(ReplaysFacetsRequest)
const isTraceSummaries = Schema.is(SessionTraceSummariesRequest)

const iso = (value: DateTime.Utc) => DateTime.formatIso(value)
const isoOrNull = (value: DateTime.Utc | null) => (value === null ? null : iso(value))
const utc = (value: string | undefined) =>
	value === undefined ? undefined : Option.getOrUndefined(parseUtc(value))
const windowOf = (query: unknown) => ({
	startTime: utc(str(query, "window_start")),
	endTime: utc(str(query, "window_end")),
})
const notFound = Effect.fail(V2SessionReplayNotFound.make())
const orNotFound = <A>(found: Option.Option<A>) =>
	Option.match(found, { onNone: () => notFound, onSome: Effect.succeed })

const tenantOf = (dataset: Dataset) =>
	Option.match(Option.fromUndefinedOr(tenantFor(dataset)), {
		onNone: () => notFound,
		onSome: Effect.succeed,
	})

export const replayEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => {
	const replays = Effect.runSync(
		SessionReplayReadService.make.pipe(
			Effect.provideService(WarehouseQueryService, warehouse.executor),
			// No replay bucket, as self-hosted: chunks carry their payload inline.
			Effect.provideService(ReplayBlobStore, Effect.runSync(ReplayBlobStore.make)),
		),
	)
	return {
		"sessionReplays.search": ({ dataset, payload }) =>
			Effect.gen(function* () {
				if (!isSearch(payload)) return yield* notFound
				const tenant = yield* tenantOf(dataset)
				const limit = payload.limit ?? LIST_LIMIT_DEFAULT
				const startTime =
					utc(payload.start_time) ?? DateTime.makeUnsafe(epochMs(dataset.now) - 86_400_000)
				const endTime = utc(payload.end_time) ?? DateTime.makeUnsafe(epochMs(dataset.now))
				const rows = yield* replays.search(
					tenant,
					{
						...(payload.service_name === undefined
							? undefined
							: { serviceName: payload.service_name }),
						...(payload.browser === undefined ? undefined : { browser: payload.browser }),
						...(payload.country === undefined ? undefined : { country: payload.country }),
						...(payload.device_type === undefined
							? undefined
							: { deviceType: payload.device_type }),
						...(payload.has_errors === undefined ? undefined : { hasErrors: payload.has_errors }),
						...(payload.search === undefined ? undefined : { search: payload.search }),
						...(payload.page_path === undefined ? undefined : { pagePath: payload.page_path }),
						...(payload.tags === undefined ? undefined : { tags: payload.tags }),
						limit: limit + 1,
					},
					{ startTime, endTime },
				)
				return {
					object: "list",
					data: rows.slice(0, limit).map((row) => ({
						id: publicId(row.sessionId),
						object: "session_replay",
						start_time: iso(row.startTime),
						end_time: isoOrNull(row.endTime),
						duration_ms: row.durationMs,
						status: row.status,
						last_activity_at: isoOrNull(row.lastActivityAt),
						user_id: row.userId ? row.userId : null,
						user_name: row.userName,
						user_email: row.userEmail,
						group_id: row.groupId,
						group_name: row.groupName,
						visitor_id: row.visitorId,
						utm_source: row.utmSource,
						entry_path: row.entryPath,
						recorded: row.recorded === "true" ? true : row.recorded === "false" ? false : null,
						url_initial: row.urlInitial,
						browser_name: row.browserName,
						os_name: row.osName,
						device_type: row.deviceType,
						country: row.country,
						service_name: row.serviceName,
						page_views: row.pageViews,
						click_count: row.clickCount,
						error_count: row.errorCount,
						trace_count: row.traceCount,
						tags: sessionTagsOf(row),
					})),
					// Paging past the first page is not part of any scenario.
					has_more: false,
					next_cursor: null,
				}
			}),
		"sessionReplaysInternal.facets": ({ dataset, payload }) =>
			Effect.gen(function* () {
				if (!isFacets(payload)) return yield* notFound
				const tenant = yield* tenantOf(dataset)
				const { startTime, endTime, ...filters } = payload
				const rows = yield* replays.facets(tenant, filters, { startTime, endTime })
				const pick = (facetType: string) =>
					rows
						.filter((row) => row.facetType === facetType)
						.map((row) => ({ name: row.name, count: row.count }))
				const stat = (name: string) =>
					rows.find((row) => row.facetType === "durationStat" && row.name === name)?.count ?? 0
				return yield* Schema.encodeUnknownEffect(ReplaysFacetsResponse)(
					new ReplaysFacetsResponse({
						services: pick("service"),
						browsers: pick("browser"),
						countries: pick("country"),
						devices: pick("device"),
						groups: pick("group"),
						pages: pick("page"),
						tags: pick("tag"),
						errorCount: rows.find((row) => row.facetType === "error")?.count ?? 0,
						totalSessions: rows.find((row) => row.facetType === "total")?.count ?? 0,
						liveSessions: rows.find((row) => row.facetType === "live")?.count ?? 0,
						durationBuckets: pick("durationBucket"),
						durationP50: stat("p50"),
						durationP95: stat("p95"),
					}),
				)
			}),
		"sessionReplaysInternal.traceSummaries": ({ dataset, payload }) =>
			Effect.gen(function* () {
				if (!isTraceSummaries(payload)) return yield* notFound
				const tenant = yield* tenantOf(dataset)
				const rows = yield* replays.traceSummaries(tenant, {
					traceIds: payload.traceIds,
					startTime: utc(payload.windowStart),
					endTime: utc(payload.windowEnd),
				})
				return yield* Schema.encodeUnknownEffect(SessionTraceSummariesResponse)(
					new SessionTraceSummariesResponse({
						data: rows.map((row) => ({
							...row,
							startTime: iso(row.startTime),
							traceId: decodeTraceId(row.traceId),
						})),
					}),
				)
			}),
		"sessionReplays.retrieve": ({ dataset, params, query }) =>
			Effect.gen(function* () {
				const tenant = yield* tenantOf(dataset)
				const { session: data, activity } = yield* replays
					.retrieve(tenant, str(params, "id") ?? "", windowOf(query))
					.pipe(Effect.flatMap(orNotFound))
				return {
					id: publicId(data.sessionId),
					object: "session_replay",
					start_time: iso(data.startTime),
					end_time: isoOrNull(data.endTime),
					duration_ms: data.durationMs,
					status: data.status,
					user_id: data.userId ? data.userId : null,
					user_name: data.userName,
					user_email: data.userEmail,
					group_id: data.groupId,
					group_name: data.groupName,
					visitor_id: data.visitorId,
					visitor_is_new: data.visitorIsNew === 1,
					user_traits: data.userTraits,
					referrer: data.referrer,
					referrer_host: data.referrerHost,
					utm_source: data.utmSource,
					utm_medium: data.utmMedium,
					utm_campaign: data.utmCampaign,
					utm_term: data.utmTerm,
					utm_content: data.utmContent,
					host: data.host,
					entry_path: data.entryPath,
					exit_path: data.exitPath,
					language: data.language,
					last_activity_at: isoOrNull(data.lastActivityAt),
					url_initial: data.urlInitial,
					browser_name: data.browserName,
					os_name: data.osName,
					device_type: data.deviceType,
					country: data.country,
					service_name: data.serviceName,
					page_views: data.pageViews,
					click_count: data.clickCount,
					error_count: data.errorCount,
					trace_count: data.traceIds.length,
					user_agent: data.userAgent,
					trace_ids: data.traceIds.map((traceId) => decodeTraceId(traceId)),
					resource_attributes: data.resourceAttributes,
					active_time_ms: activity ? activity.activeTimeMs : null,
					idle_time_ms: activity ? activity.idleTimeMs : null,
				}
			}),
		"sessionReplays.manifest": ({ dataset, params, query }) =>
			Effect.gen(function* () {
				const tenant = yield* tenantOf(dataset)
				const id = str(params, "id") ?? ""
				const rows = yield* replays
					.chunkIndex(tenant, id, windowOf(query))
					.pipe(Effect.flatMap(orNotFound))
				const chunks = rows.slice(0, MAX_REPLAY_MANIFEST_CHUNKS).map((row) => ({
					chunk_seq: row.chunkSeq,
					timestamp: iso(row.timestamp),
					duration_ms: row.durationMs,
					event_count: row.eventCount,
					byte_size: row.byteSize,
					is_checkpoint: row.isCheckpoint !== 0,
				}))
				return {
					object: "session_replay.manifest",
					session_id: publicId(id),
					chunks,
					chunk_count: chunks.length,
					total_byte_size: chunks.reduce((sum, chunk) => sum + chunk.byte_size, 0),
					max_chunks_per_request: MAX_REPLAY_CHUNKS_PER_REQUEST,
					max_bytes_per_request: MAX_REPLAY_RANGE_PAYLOAD_BYTES,
					truncated: rows.length > MAX_REPLAY_MANIFEST_CHUNKS,
				}
			}),
		"sessionReplays.events": ({ dataset, params, query }) =>
			Effect.gen(function* () {
				const tenant = yield* tenantOf(dataset)
				const id = str(params, "id") ?? ""
				const fromChunkSeq = num(query, "from_chunk_seq")
				const requestedTo = num(query, "to_chunk_seq")
				const toChunkSeq =
					fromChunkSeq === undefined
						? requestedTo
						: Math.min(
								requestedTo ?? Number.POSITIVE_INFINITY,
								fromChunkSeq + MAX_REPLAY_CHUNKS_PER_REQUEST - 1,
							)
				const pageQuery = {
					limit: Math.min(num(query, "limit") ?? LIST_LIMIT_DEFAULT, MAX_REPLAY_CHUNKS_PER_REQUEST),
					...(str(query, "cursor") === undefined ? undefined : { cursor: str(query, "cursor") }),
				}
				const page = yield* paginateOffsetQuery(pageQuery, ({ limit, offset }) =>
					replays
						.eventChunks(tenant, id, windowOf(query), {
							fromChunkSeq,
							toChunkSeq: toChunkSeq === Number.POSITIVE_INFINITY ? undefined : toChunkSeq,
							limit: Math.min(limit, MAX_REPLAY_CHUNKS_PER_REQUEST + 1),
							offset,
						})
						.pipe(
							Effect.flatMap(orNotFound),
							Effect.flatMap((rows) => replays.hydrateChunks(tenant, id, rows)),
							Effect.map((rows) =>
								rows.map((row) => ({
									object: "session_replay.event_chunk",
									chunk_seq: row.chunkSeq,
									timestamp: iso(row.timestamp),
									duration_ms: row.durationMs,
									event_count: row.eventCount,
									byte_size: row.byteSize,
									is_checkpoint: row.isCheckpoint !== 0,
									events: row.events,
								})),
							),
						),
				)
				return { object: "list", ...page }
			}),
		"sessionReplays.transcript": ({ dataset, params, query }) =>
			Effect.gen(function* () {
				const tenant = yield* tenantOf(dataset)
				const id = str(params, "id") ?? ""
				const pageQuery = {
					limit: num(query, "limit") ?? LIST_LIMIT_DEFAULT,
					...(str(query, "cursor") === undefined ? undefined : { cursor: str(query, "cursor") }),
				}
				const page = yield* paginateOffsetQuery(pageQuery, ({ limit, offset }) =>
					replays.transcript(tenant, id, windowOf(query), { limit, offset }).pipe(
						Effect.flatMap(orNotFound),
						Effect.map((rows) =>
							rows.map((row) => ({
								object: "session_replay.transcript_event",
								timestamp: iso(row.timestamp),
								seq: row.seq,
								attributes: row.attributes,
								type: row.type,
								url: row.url,
								trace_id: row.traceId ? decodeTraceId(row.traceId) : null,
								level: row.level === "" ? null : row.level,
								message: row.message === "" ? null : row.message,
								target_selector: row.targetSelector === "" ? null : row.targetSelector,
								target_text: row.targetText === "" ? null : row.targetText,
								net_method:
									row.type === "network" && row.netMethod !== "" ? row.netMethod : null,
								net_url: row.type === "network" && row.netUrl !== "" ? row.netUrl : null,
								net_status: row.type === "network" ? row.netStatus : null,
								net_duration_ms: row.type === "network" ? row.netDurationMs : null,
								error_stack:
									row.type === "error" && row.errorStack !== "" ? row.errorStack : null,
							})),
						),
					),
				)
				return { object: "list", ...page }
			}),
	}
}
