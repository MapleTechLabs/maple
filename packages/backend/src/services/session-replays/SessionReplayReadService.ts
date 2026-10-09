// Warehouse reads behind the session-replay endpoints (`/v2/session_replays`
// and the dashboard's `/internal/session-replays`). Routes own request parsing
// and the wire shape; this owns the queries, their profiles and the
// "does the session exist at all" fallback that tells an empty page from a 404.

import { Context, Effect, Layer, Option } from "effect"
import type { DateTime } from "effect"
import { MAX_REPLAY_CHUNKS_PER_REQUEST, MAX_REPLAY_EVENTS_RESPONSE_BYTES } from "@maple/domain/http/v2"
import { CH } from "@maple/query-engine"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { ReplayBlobStore, type HydratableChunk } from "@maple/backend/platform/ReplayBlobStore"

/** Optional partition-pruning window around one session. */
export interface SessionWindow {
	readonly startTime?: DateTime.Utc
	readonly endTime?: DateTime.Utc
}

/** A required search window, as the list/facet queries' `param.dateTime` takes it. */
export interface SearchWindow {
	readonly startTime: DateTime.Utc | string
	readonly endTime: DateTime.Utc | string
}

export interface OffsetPage {
	readonly limit: number
	readonly offset: number
}

export interface EventChunkRange extends OffsetPage {
	readonly fromChunkSeq?: number
	readonly toChunkSeq?: number
}

const make = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService
	const blobs = yield* ReplayBlobStore

	const exists = Effect.fn("SessionReplayReadService.exists")(function* (
		tenant: TenantContext,
		sessionId: string,
		window: SessionWindow,
	) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.session.id": sessionId })
		const compiled = CH.compile(CH.getSessionReplayQuery(window), { orgId: tenant.orgId, sessionId })
		const replay = yield* warehouse.compiledQueryFirst(tenant, compiled, {
			profile: "discovery",
			context: "v2RequireReplay",
		})
		return Option.isSome(replay)
	})

	// An empty first page is either a session with nothing in this stream or no
	// session at all; only the second is `None`. Later pages are never checked.
	const someUnlessMissing =
		(tenant: TenantContext, sessionId: string, window: SessionWindow, offset: number) =>
		<Row>(rows: ReadonlyArray<Row>) =>
			rows.length > 0 || offset > 0
				? Effect.succeed(Option.some(rows))
				: Effect.map(exists(tenant, sessionId, window), (found) =>
						found ? Option.some(rows) : Option.none(),
					)

	const search = Effect.fn("SessionReplayReadService.search")(function* (
		tenant: TenantContext,
		opts: CH.SessionReplaysListOpts,
		window: SearchWindow,
	) {
		const compiled = CH.compile(CH.sessionReplaysListQuery(opts), { orgId: tenant.orgId, ...window })
		return yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "list",
			context: "v2SearchReplays",
		})
	})

	const facets = Effect.fn("SessionReplayReadService.facets")(function* (
		tenant: TenantContext,
		opts: CH.SessionReplaysFacetsOpts,
		window: SearchWindow,
	) {
		const compiled = CH.compileUnion(CH.sessionReplaysFacetsQuery(opts), {
			orgId: tenant.orgId,
			...window,
		})
		return yield* warehouse.compiledQuery(tenant, compiled, { profile: "list", context: "replaysFacets" })
	})

	const traceSummaries = Effect.fn("SessionReplayReadService.traceSummaries")(function* (
		tenant: TenantContext,
		opts: CH.SessionTraceSummariesOpts,
	) {
		// `TraceId IN ()` is invalid SQL; no correlated traces never touches the warehouse.
		if (opts.traceIds.length === 0) return []
		const compiled = CH.compile(CH.sessionTraceSummariesQuery(opts), { orgId: tenant.orgId })
		return yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "list",
			context: "sessionTraceSummaries",
		})
	})

	/** The session row plus its active/idle breakdown, or `None` for an unknown session. */
	const retrieve = Effect.fn("SessionReplayReadService.retrieve")(function* (
		tenant: TenantContext,
		sessionId: string,
		window: SessionWindow,
	) {
		const params = { orgId: tenant.orgId, sessionId }
		const detailCompiled = CH.compile(CH.getSessionReplayQuery(window), params)
		const activityCompiled = CH.compile(CH.sessionActivityQuery(window), params)
		// Resolve the org's route before fanning out, so the config read lands on an
		// empty pool instead of queueing behind a sibling's fetch. No-op once memoized.
		yield* warehouse.warmRoute(tenant)
		const [detail, activity] = yield* Effect.all(
			[
				warehouse.compiledQueryFirst(tenant, detailCompiled, {
					profile: "discovery",
					context: "v2GetReplay",
				}),
				warehouse.compiledQueryFirst(tenant, activityCompiled, {
					profile: "discovery",
					context: "v2GetReplayActivity",
				}),
			],
			{ concurrency: 2 },
		)
		return Option.map(detail, (session) => ({ session, activity: Option.getOrNull(activity) }))
	})

	/** Every chunk's index entry (never the payload), or `None` for an unknown session. */
	const chunkIndex = Effect.fn("SessionReplayReadService.chunkIndex")(function* (
		tenant: TenantContext,
		sessionId: string,
		window: SessionWindow,
	) {
		const compiled = CH.compile(CH.sessionReplayChunkIndexQuery(window), {
			orgId: tenant.orgId,
			sessionId,
		})
		// `discovery` is enough: this never reads the `Events` column, so there is
		// nothing to hydrate whatever the storage backend.
		const rows = yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "discovery",
			context: "v2GetReplayManifest",
		})
		return yield* someUnlessMissing(tenant, sessionId, window, 0)(rows)
	})

	/**
	 * One page of event chunks, still un-hydrated, or `None` for an unknown session.
	 * Fails with `WarehouseResponseLimitError` past the response ceiling, the only
	 * guard for pre-cutover rows that still carry their payload inline.
	 */
	const eventChunks = Effect.fn("SessionReplayReadService.eventChunks")(function* (
		tenant: TenantContext,
		sessionId: string,
		window: SessionWindow,
		range: EventChunkRange,
	) {
		const compiled = CH.compile(
			CH.sessionReplayEventsQuery({
				...window,
				fromChunkSeq: range.fromChunkSeq,
				toChunkSeq: range.toChunkSeq,
				limit: range.limit,
				offset: range.offset,
			}),
			{ orgId: tenant.orgId, sessionId },
		)
		const rows = yield* warehouse.compiledQueryBounded(tenant, compiled, {
			profile: "list",
			context: "v2GetReplayEvents",
			responseLimits: {
				maxRows: MAX_REPLAY_CHUNKS_PER_REQUEST + 1,
				maxBytes: MAX_REPLAY_EVENTS_RESPONSE_BYTES,
			},
		})
		return yield* someUnlessMissing(tenant, sessionId, window, range.offset)(rows)
	})

	/** Blob-backed chunks (empty `events`) get their payload from R2; inline ones pass through. */
	const hydrateChunks = <T extends HydratableChunk>(
		tenant: TenantContext,
		sessionId: string,
		chunks: ReadonlyArray<T>,
	) => blobs.hydrate(tenant.orgId, sessionId, chunks)

	/** One page of the distilled transcript, or `None` for an unknown session. */
	const transcript = Effect.fn("SessionReplayReadService.transcript")(function* (
		tenant: TenantContext,
		sessionId: string,
		window: SessionWindow,
		page: OffsetPage,
	) {
		const compiled = CH.compile(CH.sessionTranscriptQuery({ ...window, ...page }), {
			orgId: tenant.orgId,
			sessionId,
		})
		const rows = yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "list",
			context: "v2SessionTranscript",
		})
		return yield* someUnlessMissing(tenant, sessionId, window, page.offset)(rows)
	})

	const forTrace = Effect.fn("SessionReplayReadService.forTrace")(function* (
		tenant: TenantContext,
		traceId: string,
		window: SearchWindow,
		page: OffsetPage,
	) {
		const compiled = CH.compile(CH.sessionsForTraceQuery({ traceId, ...page }), {
			orgId: tenant.orgId,
			...window,
		})
		return yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "list",
			context: "v2ReplaysForTrace",
		})
	})

	return {
		search,
		facets,
		traceSummaries,
		retrieve,
		chunkIndex,
		eventChunks,
		hydrateChunks,
		transcript,
		forTrace,
	}
})

export class SessionReplayReadService extends Context.Service<SessionReplayReadService>()(
	"@maple/api/services/SessionReplayReadService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(WarehouseQueryService.layer, ReplayBlobStore.layer)),
	)
}
