import { getReleases } from "@maple/web-data/warehouse/releases"
import { Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { IdleTtl } from "../../../data/idle-ttl"
import { toLoadFailure } from "../../../data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { resolveWindow } from "../../../data/time-range"
import { readCommitDetails } from "../../kit/commit-card"
import { MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { Message, RequestMode } from "./message"
import { ReleasesData } from "./model"

/** `releasesQueryInput`: the window plus the URL filters the warehouse reads. */
export const ReleasesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	environments: Schema.optional(Schema.Array(Schema.String)),
	excludedEnvironments: Schema.optional(Schema.Array(Schema.String)),
	services: Schema.optional(Schema.Array(Schema.String)),
	/** The namespace pin, `globalNamespace: "top"`. */
	namespaces: Schema.optional(Schema.Array(Schema.String)),
})
export type ReleasesInput = typeof ReleasesInput.Type

const mutable = <A>(values: ReadonlyArray<A> | undefined): Array<A> | undefined =>
	values === undefined ? undefined : [...values]

export const ResolveReleasesWindow = Command.define("ResolveReleasesWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

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
					environments: mutable(input.environments),
					excludedEnvironments: mutable(input.excludedEnvironments),
					services: mutable(input.services),
					namespaces: mutable(input.namespaces),
				},
			}),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchReleases({ key, result })),
		),
})

/** `useReleaseIssueCounts`: issues introduced inside the window, one page. */
export const FetchReleaseIssues = Command.define("FetchReleaseIssues", {
	args: { key: Schema.String, introducedAfter: Schema.String },
	messages: [Message.CompletedFetchIssues],
	execute: ({ key, introducedAfter }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const page = yield* client.errorIssues.list({ query: { introduced_after: introducedAfter, limit: 100 } })
			return { data: page.data, hasMore: page.has_more }
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchIssues({ key, result })),
		),
})

/** `commitsQueryAtom(shasKey)`: every release sha on screen in one request. */
export const FetchReleaseCommits = Command.define("FetchReleaseCommits", {
	args: { key: Schema.String, shas: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchCommits],
	execute: ({ key, shas, refresh }) =>
		Effect.gen(function* () {
			const response = yield* readCommitDetails(key, shas, refresh)
			return response.commits
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchCommits({ key, result })),
		),
})

/** `commitRangesAtom`: the commits each release carried, counts only (`limit: 0`). */
export const FetchReleaseRanges = Command.define("FetchReleaseRanges", {
	args: { key: Schema.String, ranges: Schema.String, limit: Schema.Number },
	messages: [Message.CompletedFetchRanges],
	execute: ({ key, ranges, limit }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const response = yield* client.integrations.vcsCommitRanges({ query: { ranges, limit } })
			return response.ranges
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchRanges({ key, result })),
		),
})

export const CompleteReleasesReloadSpin = Command.define("CompleteReleasesReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

/** The table is on screen: what `ReleasesTable` reads once it mounts follows. */
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

/** `useTrackWidth`: the first lane's track width, now and on every resize. */
export const MeasureReleasesTrack = Mount.defineStream("MeasureReleasesTrack", {
	messages: [Message.MeasuredTrack],
	execute: ({ element }) =>
		Stream.callback<ReturnType<typeof Message.MeasuredTrack>>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					Queue.offerUnsafe(queue, Message.MeasuredTrack({ width: element.getBoundingClientRect().width }))
					const observer = new ResizeObserver((entries) => {
						const entry = entries[0]
						if (entry) Queue.offerUnsafe(queue, Message.MeasuredTrack({ width: entry.contentRect.width }))
					})
					observer.observe(element)
					return () => observer.disconnect()
				}),
				(cleanup) => Effect.sync(cleanup),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
