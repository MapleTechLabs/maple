import type {
	VercelInfraBreakdownRow,
	VercelInfraLatencyBucket,
	VercelInfraProject,
	VercelInfraRequestBucket,
} from "@maple/domain/http"
import {
	getVercelAiGateway,
	getVercelAuditLog,
	getVercelBreakdown,
	getVercelLatencyTimeseries,
	getVercelDependencies,
	getVercelFunctions,
	getVercelProjectDetail,
	getVercelProjects,
	getVercelRequestTimeseries,
	getVercelSpeedInsights,
	getVercelWebAnalytics,
} from "@maple/web-data/warehouse/vercel-infra"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { TimeWindow } from "../../../data/time-range"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { MapleInternalApiClient } from "../../../platform/api-clients"

// The Vercel reads as Effects; each page wraps them in its own Commands.

/** The request series and AI Gateway reads: the window, its bucket, and one project or all. */
export const SeriesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
	projectId: Schema.optional(Schema.String),
})
export type SeriesInput = typeof SeriesInput.Type

/** Both pages' default window; matches the API's. */
export const DEFAULT_PRESET = "24h"

const BUCKET_STEPS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21_600, 43_200, 86_400]

/**
 * About 120 points over the window. Finer than the shared infra rule (five minutes at least, for
 * scraped metrics): the drains send every request, so a ten-minute window still draws a line.
 */
export const vercelBucketSeconds = (window: Pick<TimeWindow, "startTime" | "endTime">): number => {
	const seconds = Math.max(0, (toEpochMs(window.endTime) - toEpochMs(window.startTime)) / 1000)
	return Option.getOrElse(
		Arr.findFirst(BUCKET_STEPS, (step) => step * 120 >= seconds),
		() => 86_400,
	)
}

/** The window's series input, bucketed for about 120 points. */
export const seriesInput = (window: TimeWindow): SeriesInput => ({
	startTime: window.startTime,
	endTime: window.endTime,
	bucketSeconds: vercelBucketSeconds(window),
})

/** The Speed Insights and Web Analytics reads: the window, for one project or all. */
export const WindowInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	projectId: Schema.optional(Schema.String),
})
export type WindowInput = typeof WindowInput.Type

export const ProjectInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	projectId: Schema.String,
})
export type ProjectInput = typeof ProjectInput.Type

/** `vercelStatusAtom`. */
export const loadVercelStatus = Effect.gen(function* () {
	const client = yield* MapleInternalApiClient
	return yield* client.integrations.vercelStatus()
}).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `vercelProjectsResultAtom({ data: window })`. */
export const loadVercelProjects = (window: TimeWindow) =>
	getVercelProjects({ data: { startTime: window.startTime, endTime: window.endTime } }).pipe(
		Effect.mapBoth({
			onSuccess: (response): ReadonlyArray<VercelInfraProject> => response.projects,
			onFailure: toLoadFailure,
		}),
		Effect.result,
	)

/** `vercelRequestTimeseriesResultAtom({ data })`. */
export const loadVercelRequestSeries = (input: SeriesInput) =>
	getVercelRequestTimeseries({ data: { ...input } }).pipe(
		Effect.mapBoth({
			onSuccess: (response): ReadonlyArray<VercelInfraRequestBucket> => response.buckets,
			onFailure: toLoadFailure,
		}),
		Effect.result,
	)

/** Edge latency, invocations and cold starts per bucket, from the trace drain. */
export const loadVercelLatencySeries = (input: SeriesInput) =>
	getVercelLatencyTimeseries({ data: { ...input } }).pipe(
		Effect.mapBoth({
			onSuccess: (response): ReadonlyArray<VercelInfraLatencyBucket> => response.buckets,
			onFailure: toLoadFailure,
		}),
		Effect.result,
	)

/** The traffic tab's breakdown: one project's requests by one log attribute. */
export const BreakdownInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	projectId: Schema.String,
	dimension: Schema.Literals(["path", "host", "region", "source", "cache", "waf", "status"]),
	status: Schema.optional(Schema.Literals(["4xx", "5xx"])),
})
export type BreakdownInput = typeof BreakdownInput.Type

export const loadVercelBreakdown = (input: BreakdownInput) =>
	getVercelBreakdown({ data: { ...input } }).pipe(
		Effect.mapBoth({
			onSuccess: (response): ReadonlyArray<VercelInfraBreakdownRow> => response.rows,
			onFailure: toLoadFailure,
		}),
		Effect.result,
	)

/** `vercelAiGatewayResultAtom({ data })`. */
export const loadVercelAiGateway = (input: SeriesInput) =>
	getVercelAiGateway({ data: { ...input } }).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `vercelProjectDetailResultAtom({ data })`. */
export const loadVercelProjectDetail = (input: ProjectInput) =>
	getVercelProjectDetail({ data: { ...input } }).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `vercelFunctionsResultAtom({ data })`. */
export const loadVercelFunctions = (input: ProjectInput) =>
	getVercelFunctions({ data: { ...input } }).pipe(
		Effect.mapBoth({ onSuccess: (response) => response.functions, onFailure: toLoadFailure }),
		Effect.result,
	)

/** `vercelDependenciesResultAtom({ data })`. */
export const loadVercelDependencies = (input: ProjectInput) =>
	getVercelDependencies({ data: { ...input } }).pipe(
		Effect.mapBoth({ onSuccess: (response) => response.dependencies, onFailure: toLoadFailure }),
		Effect.result,
	)

/** `vercelSpeedInsightsResultAtom({ data })`. */
export const loadVercelSpeedInsights = (input: WindowInput) =>
	getVercelSpeedInsights({ data: { ...input } }).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `vercelWebAnalyticsResultAtom({ data })`. */
export const loadVercelWebAnalytics = (input: WindowInput) =>
	getVercelWebAnalytics({ data: { ...input } }).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `vercelAuditLogResultAtom({ data: window })`. */
export const loadVercelAuditLog = (window: TimeWindow) =>
	getVercelAuditLog({ data: { startTime: window.startTime, endTime: window.endTime } }).pipe(
		Effect.mapBoth({ onSuccess: (response) => response.events, onFailure: toLoadFailure }),
		Effect.result,
	)

export const DEPLOYMENTS_LIMIT = 20

/** `integrations.vercelDeployments`: the newest deployments of one project, or of the whole team. */
export const loadVercelDeployments = (projectId: string | undefined) =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const response = yield* client.integrations.vercelDeployments({
			query:
				projectId === undefined
					? { limit: DEPLOYMENTS_LIMIT }
					: { projectId, limit: DEPLOYMENTS_LIMIT },
		})
		return response.deployments
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)
