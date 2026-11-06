import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	MapleInternalApi,
	ReplaysFacetsResponse,
	SessionTraceSummariesResponse,
	TraceId,
} from "@maple/domain/http"
import { DateTime, Effect, Option, Schema, Array as Arr } from "effect"
import { parseUtc } from "@maple/query-engine"
import { SessionReplayReadService } from "@maple/backend/services/session-replays/SessionReplayReadService"

const decodeTraceId = Schema.decodeSync(TraceId)

/** An optional, already validated window bound as a `DateTime.Utc`. */
const optionalUtc = (value: string | undefined) =>
	value === undefined ? undefined : Option.getOrUndefined(parseUtc(value))

/**
 * Dashboard-only session-replay helpers.
 *
 * Facet counts feed the replays filter sidebar and trace summaries feed a
 * session's timeline — both are shaped by what those views render, so they stay
 * off the public API.
 */
export const HttpSessionReplaysInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"sessionReplaysInternal",
	(handlers) =>
		Effect.gen(function* () {
			const replays = yield* SessionReplayReadService

			return handlers
				.handle("facets", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const rows = yield* replays.facets(
							tenant,
							{
								serviceName: payload.serviceName,
								browser: payload.browser,
								country: payload.country,
								deviceType: payload.deviceType,
								userId: payload.userId,
								userSearch: payload.userSearch,
								groupName: payload.groupName,
								groupId: payload.groupId,
								visitorId: payload.visitorId,
								hasErrors: payload.hasErrors,
								search: payload.search,
								pagePath: payload.pagePath,
								tags: payload.tags,
							},
							{ startTime: payload.startTime, endTime: payload.endTime },
						)
						// The union derives its row schema from the first branch, so `count` is
						// already a number here even where ClickHouse quotes a UInt64.
						const pick = (facetType: string) =>
							Arr.map(
								Arr.filter(rows, (row) => row.facetType === facetType),
								(row) => ({ name: row.name, count: row.count }),
							)
						// The percentile branches ride the same {name, count} shape as the
						// facets, with the quantile in `count` — read them back by label.
						const countOf = (predicate: (row: (typeof rows)[number]) => boolean) =>
							Option.match(Arr.findFirst(rows, predicate), {
								onNone: () => 0,
								onSome: (row) => row.count,
							})
						const stat = (name: string) =>
							countOf((row) => row.facetType === "durationStat" && row.name === name)
						return new ReplaysFacetsResponse({
							services: pick("service"),
							browsers: pick("browser"),
							countries: pick("country"),
							devices: pick("device"),
							groups: pick("group"),
							pages: pick("page"),
							tags: pick("tag"),
							errorCount: countOf((row) => row.facetType === "error"),
							totalSessions: countOf((row) => row.facetType === "total"),
							liveSessions: countOf((row) => row.facetType === "live"),
							durationBuckets: pick("durationBucket"),
							durationP50: stat("p50"),
							durationP95: stat("p95"),
						})
					}),
				)
				.handle("traceSummaries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							"maple.trace.count": payload.traceIds.length,
						})
						const rows = yield* replays.traceSummaries(tenant, {
							traceIds: payload.traceIds,
							startTime: optionalUtc(payload.windowStart),
							endTime: optionalUtc(payload.windowEnd),
						})
						return new SessionTraceSummariesResponse({
							data: Arr.map(rows, (row) => ({
								...row,
								startTime: DateTime.formatIso(row.startTime),
								traceId: decodeTraceId(row.traceId),
							})),
						})
					}),
				)
		}),
)
