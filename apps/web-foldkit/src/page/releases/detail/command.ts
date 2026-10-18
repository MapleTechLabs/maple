import { getReleases } from "@maple/web-data/warehouse/releases"
import { Clock, Duration, Effect, type Result, Schema } from "effect"
import { Command } from "foldkit"
import { type LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { resolveWindow } from "../../../data/time-range"
import { MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { RequestMode } from "../list/message"
import { Message } from "./message"

const finish = <A, E, R, M>(effect: Effect.Effect<A, E, R>, toMessage: (result: Result.Result<A, LoadFailure>) => M) =>
	effect.pipe(Effect.mapError(toLoadFailure), Effect.result, Effect.map(toMessage))

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
		finish(
			Effect.gen(function* () {
				const client = yield* MapleInternalApiClient
				return yield* client.integrations.vcsCommitDetail({ params: { sha } })
			}),
			(result) => Message.CompletedFetchCommit({ key, result }),
		),
})

/** `getReleasesResultAtom({ startTime, endTime, environments })`: the list's unfiltered read. */
export const FetchDeployReleases = Command.define("FetchDeployReleases", {
	args: {
		key: Schema.String,
		startTime: Schema.String,
		endTime: Schema.String,
		environments: Schema.optional(Schema.Array(Schema.String)),
	},
	messages: [Message.CompletedFetchReleases],
	execute: ({ key, startTime, endTime, environments }) =>
		finish(
			getReleases({ data: { startTime, endTime, environments: environments === undefined ? undefined : [...environments] } }),
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
				const page = yield* client.errorIssues.list({ query: { introduced_after: introducedAfter, limit: 100 } })
				return page.data
			}),
			(result) => Message.CompletedFetchIssues({ key, result }),
		),
})

export const CompleteReleaseReloadSpin = Command.define("CompleteReleaseReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
