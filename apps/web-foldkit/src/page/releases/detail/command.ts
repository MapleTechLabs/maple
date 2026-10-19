import { getReleaseDetail, getReleases } from "@maple/web-data/warehouse/releases"
import { Clock, Duration, Effect, Predicate, type Result, Schema } from "effect"
import { Command } from "foldkit"
import { IdleTtl } from "../../../data/idle-ttl"
import { type LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { resolveWindow } from "../../../data/time-range"
import { readCommitDetail } from "../../kit/commit-card"
import { MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { RequestMode } from "../list/message"
import { ReleasesData } from "../list/model"
import { ReleaseDetail } from "./model"
import { Message } from "./message"

const finish = <A, E, R, M>(
	effect: Effect.Effect<A, E, R>,
	toMessage: (result: Result.Result<A, LoadFailure>) => M,
) => effect.pipe(Effect.mapError(toLoadFailure), Effect.result, Effect.map(toMessage))

export const ResolveReleaseWindow = Command.define("ResolveReleaseWindow", {
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

/** `commitQueryAtom(sha)`. */
export const FetchReleaseCommit = Command.define("FetchReleaseCommit", {
	args: { key: Schema.String, sha: Schema.String },
	messages: [Message.CompletedFetchCommit],
	execute: ({ key, sha }) =>
		finish(readCommitDetail(key, sha), (result) => Message.CompletedFetchCommit({ key, result })),
})

/** `getReleasesResultAtom({ startTime, endTime, environments })` with the pin: the list's unfiltered read. */
export const FetchDeployReleases = Command.define("FetchDeployReleases", {
	args: {
		key: Schema.String, refresh: Schema.Boolean,
		startTime: Schema.String,
		endTime: Schema.String,
		environments: Schema.optional(Schema.Array(Schema.String)),
		namespaces: Schema.optional(Schema.Array(Schema.String)),
	},
	messages: [Message.CompletedFetchReleases],
	execute: ({ key, refresh, startTime, endTime, environments, namespaces }) =>
		finish(
			readThrough(
				{ key, refresh, idleTtlMs: IdleTtl.releases, schema: ReleasesData },
				getReleases({
					data: {
						startTime,
						endTime,
						environments: environments === undefined ? undefined : [...environments],
						namespaces: namespaces === undefined ? undefined : [...namespaces],
					},
				}),
			),
			(result) => Message.CompletedFetchReleases({ key, result }),
		),
})

/** `ReleaseChangesetLoaded`: one `base..head` range, up to 100 commits listed. */
export const FetchChangeset = Command.define("FetchReleaseChangeset", {
	args: { key: Schema.String, ranges: Schema.String },
	messages: [Message.CompletedFetchChangeset],
	execute: ({ key, ranges }) =>
		finish(
			Effect.gen(function* () {
				const client = yield* MapleInternalApiClient
				const response = yield* client.integrations.vcsCommitRanges({ query: { ranges, limit: 100 } })
				return response.ranges
			}),
			(result) => Message.CompletedFetchChangeset({ key, result }),
		),
})

/** `DeployIssues`: issues introduced since five minutes before the deploy. */
export const FetchDeployIssues = Command.define("FetchDeployIssues", {
	args: { key: Schema.String, introducedAfter: Schema.String },
	messages: [Message.CompletedFetchIssues],
	execute: ({ key, introducedAfter }) =>
		finish(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				const page = yield* client.errorIssues.list({
					query: { introduced_after: introducedAfter, limit: 100 },
				})
				return page.data
			}),
			(result) => Message.CompletedFetchIssues({ key, result }),
		),
})

/** `getReleaseDetailResultAtom`: this version on one service, and the version it replaced. */
export const FetchReleaseDetail = Command.define("FetchReleaseDetail", {
	args: {
		key: Schema.String, refresh: Schema.Boolean,
		serviceName: Schema.String,
		commitSha: Schema.String,
		baselineCommitSha: Schema.UndefinedOr(Schema.String),
		startTime: Schema.String,
		endTime: Schema.String,
		environments: Schema.UndefinedOr(Schema.Array(Schema.String)),
	},
	messages: [Message.CompletedFetchDetail],
	execute: ({ key, refresh, environments, ...input }) =>
		finish(
			readThrough(
				{ key, refresh, idleTtlMs: IdleTtl.releaseDetail, schema: ReleaseDetail },
				getReleaseDetail({
					data: {
						...input,
						environments: environments === undefined ? undefined : [...environments],
					},
				}),
			),
			(result) => Message.CompletedFetchDetail({ key, result }),
		),
})

/** `ReleaseIssuesLoaded`: the v2 issues of the fingerprints this version carried, on its service. */
export const FetchServiceIssues = Command.define("FetchReleaseServiceIssues", {
	args: {
		key: Schema.String,
		serviceName: Schema.String,
		fingerprints: Schema.String,
		limit: Schema.Number,
	},
	messages: [Message.CompletedFetchServiceIssues],
	execute: ({ key, serviceName, fingerprints, limit }) =>
		finish(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				const page = yield* client.errorIssues.list({
					query: { service_name: serviceName, fingerprint_hash: fingerprints, limit },
				})
				return page.data
			}),
			(result) => Message.CompletedFetchServiceIssues({ key, result }),
		),
})

/** `commitQueryAtom(sha)` for a commit marker's label. */
export const FetchMarkerCommit = Command.define("FetchReleaseMarkerCommit", {
	args: { key: Schema.String, sha: Schema.String },
	messages: [Message.CompletedFetchMarkerCommit],
	execute: ({ key, sha }) =>
		Effect.gen(function* () {
			const commit = yield* readCommitDetail(key, sha)
			return {
				sha: commit.sha,
				message: commit.message,
				authorName: commit.authorName,
				authorLogin: commit.authorLogin,
				authorAvatarUrl: commit.authorAvatarUrl,
				committedAt: commit.committedAt,
			}
		}).pipe(
			Effect.mapError((error) => ({
				tag: Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : "",
			})),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMarkerCommit({ sha, result })),
		),
})

export const CompleteReleaseReloadSpin = Command.define("CompleteReleaseReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
