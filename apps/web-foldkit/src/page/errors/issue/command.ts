import { ErrorIssueId } from "@maple/domain/http"
import { Clock, Duration, Effect, Result, Schema } from "effect"
import { Command } from "foldkit"
import { type LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { resolveWindow } from "../../../data/time-range"
import { MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { Message, RequestMode } from "./message"

/** The fetch's outcome, its error already the `displayError` body. */
const settle = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<Result.Result<A, LoadFailure>, never, R> =>
	effect.pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `useEffectiveTimeRange(search.startTime, search.endTime, preset)`. */
export const ResolveWindow = Command.define("ResolveIssueWindow", {
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

export const DetailQuery = Schema.Struct({
	start_time: Schema.String,
	end_time: Schema.String,
	bucket_seconds: Schema.Number,
	sample_limit: Schema.Number,
})
export type DetailQuery = typeof DetailQuery.Type

export const FetchDetail = Command.define("FetchErrorIssueDetail", {
	args: { key: Schema.String, issueId: ErrorIssueId, query: DetailQuery },
	messages: [Message.CompletedFetchDetail],
	execute: ({ key, issueId, query }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.errorIssues.retrieve({ params: { id: issueId }, query })
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchDetail({ key, result })),
		),
})

export const FetchEvents = Command.define("FetchErrorIssueEvents", {
	args: { key: Schema.String, issueId: ErrorIssueId },
	messages: [Message.CompletedFetchEvents],
	execute: ({ key, issueId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.errors.listIssueEvents({ params: { issueId }, query: { limit: 200 } })
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchEvents({ key, result })),
		),
})

export const FetchInvestigations = Command.define("FetchErrorIssueInvestigations", {
	args: { key: Schema.String, issueId: ErrorIssueId },
	messages: [Message.CompletedFetchInvestigations],
	execute: ({ key, issueId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.investigations.list({ query: { issue_id: issueId, limit: 10 } })
			return response.data
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchInvestigations({ key, result })),
		),
})

export const FetchPullRequests = Command.define("FetchErrorIssuePullRequests", {
	args: { key: Schema.String, issueId: ErrorIssueId },
	messages: [Message.CompletedFetchPullRequests],
	execute: ({ key, issueId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.errors.listIssuePullRequests({ params: { issueId } })
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchPullRequests({ key, result })),
		),
})

export const FetchVerifications = Command.define("FetchErrorIssueVerifications", {
	args: { key: Schema.String, issueId: ErrorIssueId },
	messages: [Message.CompletedFetchVerifications],
	execute: ({ key, issueId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.errors.listIssueVerifications({ params: { issueId } })
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchVerifications({ key, result })),
		),
})

export const FetchEscalations = Command.define("FetchErrorIssueEscalations", {
	args: { key: Schema.String, issueId: ErrorIssueId },
	messages: [Message.CompletedFetchEscalations],
	execute: ({ key, issueId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.errors.listIssueEscalations({ params: { issueId } })
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchEscalations({ key, result })),
		),
})

/** `useRelatedAnomalies`: detector incidents linked to this issue. */
export const FetchAnomalies = Command.define("FetchErrorIssueAnomalies", {
	args: { key: Schema.String, issueId: ErrorIssueId },
	messages: [Message.CompletedFetchAnomalies],
	execute: ({ key, issueId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.anomalies.listIncidents({
				query: { error_issue_id: issueId, limit: 50 },
			})
			return response.data
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchAnomalies({ key, result })),
		),
})

/** The attach dialog's GitHub connection, read while the dialog is mounted (closed). */
export const FetchGithubStatus = Command.define("FetchGithubStatus", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchGithubStatus],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.githubStatus()
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchGithubStatus({ key, result })),
		),
})

/** `VCS_PULL_REQUESTS_DEFAULT_LIMIT` pull requests of the selected repository. */
export const FetchVcsPullRequests = Command.define("FetchVcsPullRequests", {
	args: { key: Schema.String, repository: Schema.String },
	messages: [Message.CompletedFetchVcsPullRequests],
	execute: ({ key, repository }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.vcsPullRequests({ query: { repository, limit: 50 } })
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchVcsPullRequests({ key, result })),
		),
})

/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
export const CompleteReloadSpin = Command.define("CompleteIssueReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
