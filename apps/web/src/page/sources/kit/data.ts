import type { SourceId } from "@maple/domain/primitives"
import { V2Source, V2SourceUsage, V2SourceUsageSummary } from "@maple/domain/http/v2"
import { collectV2Pages } from "@maple/web-data/lib/v2-pagination"
import { Effect, Schema } from "effect"
import { IdleTtl } from "../../../data/idle-ttl"
import { toLoadFailure } from "../../../data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { type RequestKey, requestKey } from "../../../data/request-key"
import { MapleApiV2Client } from "../../../platform/api-clients"

// The sources list and the detail page's `retainedQueryV2("sources", "usage" | "retrieve")` reads, through
// the read cache.

const PAGE_LIMIT = 100

/**
 * The list atom has no idle TTL: it is dropped once no page reads it. A route swap between two
 * source pages keeps it mounted, so one second after a release covers the handover.
 */
export const SOURCES_LIST_IDLE_TTL_MS = 1_000

export const SourceList = Schema.Array(V2Source)

export const sourcesListKey = (orgId: string): RequestKey =>
	requestKey(orgId, "sources.list", { query: { limit: PAGE_LIMIT } })

/** Every page of the org's sources; `refresh` is `useAtomRefresh(sourcesListAtom)`. */
export const loadSources = (key: RequestKey, refresh: boolean) =>
	readThrough(
		{ key, idleTtlMs: SOURCES_LIST_IDLE_TTL_MS, schema: SourceList, refresh },
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* collectV2Pages((cursor) =>
				client.sources.list({
					query: { limit: PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : undefined) },
				}),
			)
		}),
	).pipe(Effect.mapError(toLoadFailure))

export const sourceUsageKey = (orgId: string, id: SourceId): RequestKey =>
	requestKey(orgId, "sources.usage", { params: { id } })

/** `retainedQueryV2("sources", "usage", { params: { id } })`. */
export const loadSourceUsage = (key: RequestKey, id: SourceId) =>
	readThrough(
		{ key, idleTtlMs: IdleTtl.retainedQuery, schema: V2SourceUsage },
		Effect.flatMap(MapleApiV2Client, (client) => client.sources.usage({ params: { id } })),
	).pipe(Effect.mapError(toLoadFailure))

export const sourcesUsageKey = (orgId: string): RequestKey => requestKey(orgId, "sources.usageSummary", {})

/** Every source's volume over the last 24 hours, for the list's Last 24h column. */
export const loadSourcesUsage = (key: RequestKey, refresh: boolean) =>
	readThrough(
		{ key, idleTtlMs: IdleTtl.retainedQuery, schema: V2SourceUsageSummary, refresh },
		Effect.flatMap(MapleApiV2Client, (client) => client.sources.usageSummary({})),
	).pipe(Effect.mapError(toLoadFailure))

export const sourceRetrieveKey = (orgId: string, id: SourceId): RequestKey =>
	requestKey(orgId, "sources.retrieve", { params: { id } })

/** `retainedQueryV2("sources", "retrieve", { params: { id } })`; `refresh` is the 5 s poll. */
export const loadSource = (key: RequestKey, id: SourceId, refresh: boolean) =>
	readThrough(
		{ key, idleTtlMs: IdleTtl.retainedQuery, schema: V2Source, refresh },
		Effect.flatMap(MapleApiV2Client, (client) => client.sources.retrieve({ params: { id } })),
	).pipe(Effect.mapError(toLoadFailure))
