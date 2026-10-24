import {
	getServiceDetailOverview,
	getServiceDetailThroughputRefinement,
} from "@maple/web-data/warehouse/custom-charts"
import {
	getServiceApiOverview,
	getServiceEndpointStatusBreakdown,
	getServiceEndpoints,
	getServiceEndpointsTimeseries,
} from "@maple/web-data/warehouse/service-endpoints"
import { getServiceOperations } from "@maple/web-data/warehouse/service-operations"
import { getServiceUsage } from "@maple/web-data/warehouse/service-usage"
import { getServiceWorkloads } from "@maple/web-data/warehouse/service-infra"
import { getServiceDependenciesBundle } from "@maple/web-data/warehouse/service-map"
import { V2ErrorIssueListQuery } from "@maple/domain/http/v2"
import { Clock, Duration, Effect, Predicate, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { readCommitDetail } from "../../kit/commit-card"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { Message, RequestMode } from "./message"

const Names = Schema.optional(Schema.Array(Schema.String))
const mutable = <A>(values: ReadonlyArray<A> | undefined): Array<A> | undefined =>
	values === undefined ? undefined : [...values]

/** Entry and Reload: the clock, so the window resolves (snapped on entry, unsnapped after Reload). */
export const ResolveClock = Command.define("ResolveServiceDetailClock", {
	args: { mode: RequestMode },
	messages: [Message.CompletedResolveClock],
	execute: ({ mode }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedResolveClock({ nowMs, mode })),
})

/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
export const CompleteReloadSpin = Command.define("CompleteServiceDetailReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

/** The window, the service and the environment filter (`GetCustomChartServiceDetailInput`). */
export const DetailInput = Schema.Struct({
	serviceName: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	environments: Names,
})
export type DetailInput = typeof DetailInput.Type

export const RefinementInput = Schema.Struct({ ...DetailInput.fields, samplingActive: Schema.Boolean })
export type RefinementInput = typeof RefinementInput.Type

export const OperationsInput = Schema.Struct({
	...DetailInput.fields,
	bucketSeconds: Schema.Number,
	limit: Schema.Number,
})
export type OperationsInput = typeof OperationsInput.Type

export const UsageInput = Schema.Struct({
	service: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	previousStartTime: Schema.optional(Schema.String),
	previousEndTime: Schema.optional(Schema.String),
})
export type UsageInput = typeof UsageInput.Type

export const WorkloadsInput = Schema.Struct({
	services: Schema.Array(Schema.String),
	startTime: Schema.String,
	endTime: Schema.String,
})
export type WorkloadsInput = typeof WorkloadsInput.Type

export const DependenciesInput = Schema.Struct({
	serviceName: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	deploymentEnv: Schema.optional(Schema.String),
})
export type DependenciesInput = typeof DependenciesInput.Type

// Fetches carry their request key back so `update` drops a superseded answer (S6).

/** `getServiceDetailOverviewResultAtom`: the charts, releases and environments in one request. */
export const FetchOverview = Command.define("FetchServiceDetailOverview", {
	args: { key: Schema.String, input: DetailInput },
	messages: [Message.CompletedFetchOverview],
	execute: ({ key, input }) =>
		getServiceDetailOverview({ data: { ...input, environments: mutable(input.environments) } }).pipe(
			Effect.map((response) => ({
				points: response.data,
				releases: response.releases,
				environments: response.environments,
			})),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchOverview({ key, result })),
		),
})

/** `getServiceDetailThroughputRefinementResultAtom`: exact pre-sampling volume while sampling is on. */
export const FetchRefinement = Command.define("FetchServiceDetailRefinement", {
	args: { key: Schema.String, input: RefinementInput },
	messages: [Message.CompletedFetchRefinement],
	execute: ({ key, input }) =>
		getServiceDetailThroughputRefinement({
			data: { ...input, environments: mutable(input.environments) },
		}).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchRefinement({ key, result })),
		),
})

/** `getServiceOperationsResultAtom`, shared by the Overview panel and the Operations tab. */
export const FetchOperations = Command.define("FetchServiceOperations", {
	args: { key: Schema.String, input: OperationsInput },
	messages: [Message.CompletedFetchOperations],
	execute: ({ key, input }) =>
		getServiceOperations({ data: input }).pipe(
			Effect.map((response) => response.operations),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchOperations({ key, result })),
		),
})

export const EndpointsInput = Schema.Struct({ ...DetailInput.fields, limit: Schema.Number })
export type EndpointsInput = typeof EndpointsInput.Type

/** `getServiceEndpointsResultAtom`: the API tab's endpoints, the busiest `ENDPOINTS_LIMIT`. */
export const FetchEndpoints = Command.define("FetchServiceEndpoints", {
	args: { key: Schema.String, input: EndpointsInput },
	messages: [Message.CompletedFetchEndpoints],
	execute: ({ key, input }) =>
		getServiceEndpoints({ data: input }).pipe(
			Effect.map((response) => response.endpoints),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchEndpoints({ key, result })),
		),
})

export const FetchUsage = Command.define("FetchServiceDetailUsage", {
	args: { key: Schema.String, input: UsageInput },
	messages: [Message.CompletedFetchUsage],
	execute: ({ key, input }) =>
		getServiceUsage({ data: input }).pipe(
			Effect.map((response) => ({
				totals: response.data.reduce(
					(acc, row) => ({
						logs: acc.logs + row.totalLogs,
						traces: acc.traces + row.totalTraces,
						metrics: acc.metrics + row.totalMetrics,
						dataSize: acc.dataSize + row.dataSizeBytes,
					}),
					{ logs: 0, traces: 0, metrics: 0, dataSize: 0 },
				),
				previous: response.previousTotals ?? null,
			})),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchUsage({ key, result })),
		),
})

export const FetchWorkloads = Command.define("FetchServiceWorkloads", {
	args: { key: Schema.String, input: WorkloadsInput },
	messages: [Message.CompletedFetchWorkloads],
	execute: ({ key, input }) =>
		getServiceWorkloads({ data: input }).pipe(
			Effect.map((response) => response.workloads),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchWorkloads({ key, result })),
		),
})

/** `getServiceDependenciesBundleResultAtom`, shared by the strip and the Dependencies tab. */
export const FetchDependencies = Command.define("FetchServiceDependenciesBundle", {
	args: { key: Schema.String, input: DependenciesInput },
	messages: [Message.CompletedFetchDependencies],
	execute: ({ key, input }) =>
		getServiceDependenciesBundle({ data: input }).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDependencies({ key, result })),
		),
})

/** `retainedQueryV2("errorIssues", "list", { query: buildServiceOpenIssuesQuery(...) })`. */
export const FetchIssues = Command.define("FetchServiceOpenIssues", {
	args: { key: Schema.String, query: V2ErrorIssueListQuery },
	messages: [Message.CompletedFetchIssues],
	execute: ({ key, query }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.errorIssues.list({ query })
			return response.data.map((issue) => ({
				id: issue.id,
				title:
					issue.error_label || issue.exception_type || issue.exception_message || "Unknown error",
				severity: issue.severity,
				occurrenceCount: issue.occurrence_count,
				lastSeenAt: issue.last_seen_at,
			}))
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchIssues({ key, result })),
		),
})

const errorTag = (error: unknown): string =>
	Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : ""

/** `commitQueryAtom(sha)`: one commit, its failure kept by tag (not-connected gets a CTA). */
export const FetchCommit = Command.define("FetchServiceDeployCommit", {
	args: { key: Schema.String, sha: Schema.String },
	messages: [Message.CompletedFetchCommit],
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
			Effect.mapError((error) => ({ tag: errorTag(error) })),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchCommit({ sha, result })),
		),
})

export const ApiOverviewInput = Schema.Struct({
	...DetailInput.fields,
	previousStartTime: Schema.optional(Schema.String),
	previousEndTime: Schema.optional(Schema.String),
	bucketSeconds: Schema.Number,
})
export type ApiOverviewInput = typeof ApiOverviewInput.Type

/** `getServiceApiOverview`: the API tab's KPI totals (and the previous window's) and merged buckets. */
export const FetchApiOverview = Command.define("FetchServiceApiOverview", {
	args: { key: Schema.String, input: ApiOverviewInput },
	messages: [Message.CompletedFetchApiOverview],
	execute: ({ key, input }) =>
		getServiceApiOverview({ data: { ...input, environments: mutable(input.environments) } }).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchApiOverview({ key, result })),
		),
})

export const EndpointSeriesInput = Schema.Struct({
	...DetailInput.fields,
	bucketSeconds: Schema.Number,
	spanNames: Schema.Array(Schema.String),
})
export type EndpointSeriesInput = typeof EndpointSeriesInput.Type

/** `getServiceEndpointsTimeseries`: per-endpoint buckets for the row sparklines and the drawer charts. */
export const FetchEndpointSeries = Command.define("FetchServiceEndpointSeries", {
	args: { key: Schema.String, input: EndpointSeriesInput },
	messages: [Message.CompletedFetchEndpointSeries],
	execute: ({ key, input }) =>
		getServiceEndpointsTimeseries({
			data: { ...input, environments: mutable(input.environments), spanNames: [...input.spanNames] },
		}).pipe(
			Effect.map((response) => response.buckets),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchEndpointSeries({ key, result })),
		),
})

/** `getServiceEndpointStatusBreakdown`: every (endpoint, status code, error.type) of the window. */
export const FetchStatusBreakdown = Command.define("FetchServiceEndpointStatusBreakdown", {
	args: { key: Schema.String, input: DetailInput },
	messages: [Message.CompletedFetchStatusBreakdown],
	execute: ({ key, input }) =>
		getServiceEndpointStatusBreakdown({ data: { ...input, environments: mutable(input.environments) } }).pipe(
			Effect.map((response) => response.rows),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchStatusBreakdown({ key, result })),
		),
})
