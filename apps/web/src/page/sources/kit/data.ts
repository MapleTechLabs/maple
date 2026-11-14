import { SourceId } from "@maple/primitives"
import { V2Source, V2SourceUsage, V2SourceUsageSummary } from "@maple/domain/http/v2"
import { collectV2Pages } from "@maple/web-data/lib/v2-pagination"
import { Effect, type Result, Schema } from "effect"
import { Command } from "foldkit"
import { baseKey } from "@maple/views/data/keyed"
import { IdleTtl } from "../../../data/idle-ttl"
import { type LoadFailure, settleTo, toLoadFailure } from "@maple/views/data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { type RequestKey, requestKey } from "@maple/views/data/request-key"
import { MapleApiV2Client } from "../../../platform/api-clients"

// The sources list and the detail page's usage and retrieve reads, through the read cache.

const PAGE_LIMIT = 100

/**
 * The list is dropped once no page reads it; one second after a release covers a route swap
 * between two source pages.
 */
export const SOURCES_LIST_IDLE_TTL_MS = 1_000

export const SourceList = Schema.Array(V2Source)

export const sourcesListKey = (orgId: string): RequestKey =>
	requestKey(orgId, "sources.list", { query: { limit: PAGE_LIMIT } })

/** Every page of the org's sources. */
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

export const loadSourceUsage = (key: RequestKey, id: SourceId) =>
	readThrough(
		{ key, idleTtlMs: IdleTtl.retainedQuery, schema: V2SourceUsage },
		Effect.flatMap(MapleApiV2Client, (client) => client.sources.usage({ params: { id } })),
	).pipe(Effect.mapError(toLoadFailure))

export const sourcesUsageKey = (orgId: string): RequestKey => requestKey(orgId, "sources.usageSummary", {})

/** Every source's volume over the last 24 hours, which the list ranks and totals by. */
export const loadSourcesUsage = (key: RequestKey, refresh: boolean) =>
	readThrough(
		{ key, idleTtlMs: IdleTtl.retainedQuery, schema: V2SourceUsageSummary, refresh },
		Effect.flatMap(MapleApiV2Client, (client) => client.sources.usageSummary({})),
	).pipe(Effect.mapError(toLoadFailure))

export const sourceRetrieveKey = (orgId: string, id: SourceId): RequestKey =>
	requestKey(orgId, "sources.retrieve", { params: { id } })

/** One source; `refresh` is the 5 s poll. */
export const loadSource = (key: RequestKey, id: SourceId, refresh: boolean) =>
	readThrough(
		{ key, idleTtlMs: IdleTtl.retainedQuery, schema: V2Source, refresh },
		Effect.flatMap(MapleApiV2Client, (client) => client.sources.retrieve({ params: { id } })),
	).pipe(Effect.mapError(toLoadFailure))

type ListDone<M> = Schema.Top &
	((fields: {
		readonly key: string
		readonly result: Result.Result<typeof SourceList.Type, LoadFailure>
	}) => M)

type ResumeDone<M> = Schema.Top & ((fields: { readonly result: Result.Result<V2Source, LoadFailure> }) => M)

/** `sources.resume`, answered with the page's Message: the list's row and the source page both resume. */
export const resumeSource = <M>(done: ResumeDone<M>) =>
	Command.define("ResumeSource", {
		args: { id: SourceId },
		messages: [done],
		execute: ({ id }) =>
			Effect.flatMap(MapleApiV2Client, (client) => client.sources.resume({ params: { id } })).pipe(
				settleTo((result) => done({ result })),
			),
	})

/** The toasts a resume answers with, wherever it was clicked. */
export const RESUME_COPY = {
	success: "Source resumed. Takes effect within a minute.",
	error: "Couldn't resume source",
} as const

/** The sources list, read through the cache and answered with the page's Message; a superseded key re-reads. */
export const fetchSourcesList = <M>(done: ListDone<M>) =>
	Command.define("FetchSourcesList", {
		args: { key: Schema.String, refresh: Schema.Boolean },
		messages: [done],
		execute: ({ key, refresh }) =>
			loadSources(baseKey(key), refresh).pipe(
				Effect.result,
				Effect.map((result) => done({ key, result })),
			),
	})
