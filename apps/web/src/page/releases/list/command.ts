import { resolveWindowCommand } from "../../kit/time-frame"
import { reloadSpin } from "@maple/views/data/timing"
import { getReleases } from "@maple/web-data/warehouse/releases"
import { Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { IdleTtl } from "../../../data/idle-ttl"
import { settleTo } from "@maple/views/data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { readCommitDetails } from "../../kit/commit-card"
import { loadSignalPresences } from "../../kit/signal-presence"
import { MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { Message } from "./message"
import { ReleasesData } from "./model"

/** The window plus the URL filters the warehouse reads. */
export const ReleasesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	environments: Schema.optional(Schema.Array(Schema.String)),
	excludedEnvironments: Schema.optional(Schema.Array(Schema.String)),
	services: Schema.optional(Schema.Array(Schema.String)),
	/** The namespace pin. */
	namespaces: Schema.optional(Schema.Array(Schema.String)),
})
export type ReleasesInput = typeof ReleasesInput.Type

export const ResolveReleasesWindow = resolveWindowCommand(
	"ResolveReleasesWindow",
	Message.CompletedResolveWindow,
)

export const FetchReleases = Command.define("FetchReleases", {
	args: { key: Schema.String, refresh: Schema.Boolean, input: ReleasesInput },
	messages: [Message.CompletedFetchReleases],
	execute: ({ key, refresh, input }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.releases, schema: ReleasesData },
			getReleases({
				data: {
					startTime: input.startTime,
					endTime: input.endTime,
					environments: input.environments,
					excludedEnvironments: input.excludedEnvironments,
					services: input.services,
					namespaces: input.namespaces,
				},
			}),
		).pipe(settleTo((result) => Message.CompletedFetchReleases({ key, result }))),
})

/** Issues introduced inside the window, one page. */
export const FetchReleaseIssues = Command.define("FetchReleaseIssues", {
	args: { key: Schema.String, introducedAfter: Schema.String },
	messages: [Message.CompletedFetchIssues],
	execute: ({ key, introducedAfter }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const page = yield* client.errorIssues.list({
				query: { introduced_after: introducedAfter, limit: 100 },
			})
			return { data: page.data, hasMore: page.has_more }
		}).pipe(settleTo((result) => Message.CompletedFetchIssues({ key, result }))),
})

/** Every release sha on screen in one request. */
export const FetchReleaseCommits = Command.define("FetchReleaseCommits", {
	args: { key: Schema.String, shas: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchCommits],
	execute: ({ key, shas, refresh }) =>
		Effect.gen(function* () {
			const response = yield* readCommitDetails(key, shas, refresh)
			return response.commits
		}).pipe(settleTo((result) => Message.CompletedFetchCommits({ key, result }))),
})

/** The commits each release carried, counts only (`limit: 0`). */
export const FetchReleaseRanges = Command.define("FetchReleaseRanges", {
	args: { key: Schema.String, ranges: Schema.String, limit: Schema.Number },
	messages: [Message.CompletedFetchRanges],
	execute: ({ key, ranges, limit }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const response = yield* client.integrations.vcsCommitRanges({ query: { ranges, limit } })
			return response.ranges
		}).pipe(settleTo((result) => Message.CompletedFetchRanges({ key, result }))),
})

export const LoadReleasesSignalPresence = Command.define("LoadReleasesSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})

export const CompleteReleasesReloadSpin = reloadSpin(
	"CompleteReleasesReloadSpin",
	Message.CompletedReloadSpin,
)

/** The table is on screen: what it reads once it mounts follows. */
export const MountReleasesTable = Mount.define("MountReleasesTable", {
	messages: [Message.PaintedTable],
	execute: () =>
		Effect.callback<ReturnType<typeof Message.PaintedTable>>((resume) => {
			const handle = requestAnimationFrame(() =>
				requestAnimationFrame(() => resume(Effect.succeed(Message.PaintedTable()))),
			)
			return Effect.sync(() => cancelAnimationFrame(handle))
		}),
})

/** The first lane's track width, now and on every resize. */
export const MeasureReleasesTrack = Mount.defineStream("MeasureReleasesTrack", {
	messages: [Message.MeasuredTrack],
	execute: ({ element }) =>
		Stream.callback<ReturnType<typeof Message.MeasuredTrack>>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					Queue.offerUnsafe(
						queue,
						Message.MeasuredTrack({ width: element.getBoundingClientRect().width }),
					)
					const observer = new ResizeObserver((entries) => {
						const entry = entries[0]
						if (entry !== undefined)
							Queue.offerUnsafe(
								queue,
								Message.MeasuredTrack({ width: entry.contentRect.width }),
							)
					})
					observer.observe(element)
					return () => observer.disconnect()
				}),
				(cleanup) => Effect.sync(cleanup),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
