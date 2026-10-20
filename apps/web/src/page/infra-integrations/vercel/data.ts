import type { VercelInfraProject, VercelInfraRequestBucket } from "@maple/domain/http"
import {
	getVercelAiGateway,
	getVercelProjectDetail,
	getVercelProjects,
	getVercelRequestTimeseries,
} from "@maple/web-data/warehouse/vercel-infra"
import { Effect, Schema } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import type { TimeWindow } from "../../../data/time-range"
import { chartBucketSeconds } from "../../../charts/infra-metric-series"
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

/** The window's series input, bucketed for about a hundred points. */
export const seriesInput = (window: TimeWindow): SeriesInput => ({
	startTime: window.startTime,
	endTime: window.endTime,
	bucketSeconds: chartBucketSeconds(window.startTime, window.endTime),
})

export const ProjectInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	projectId: Schema.String,
})
export type ProjectInput = typeof ProjectInput.Type

/** `vercelStatusAtom`. */
export const loadVercelStatus = () =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		return yield* client.integrations.vercelStatus()
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `vercelProjectsResultAtom({ data: window })`. */
export const loadVercelProjects = (window: TimeWindow) =>
	getVercelProjects({ data: { startTime: window.startTime, endTime: window.endTime } }).pipe(
		Effect.map((response): ReadonlyArray<VercelInfraProject> => response.projects),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** `vercelRequestTimeseriesResultAtom({ data })`. */
export const loadVercelRequestSeries = (input: SeriesInput) =>
	getVercelRequestTimeseries({ data: { ...input } }).pipe(
		Effect.map((response): ReadonlyArray<VercelInfraRequestBucket> => response.buckets),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** `vercelAiGatewayResultAtom({ data })`. */
export const loadVercelAiGateway = (input: SeriesInput) =>
	getVercelAiGateway({ data: { ...input } }).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `vercelProjectDetailResultAtom({ data })`. */
export const loadVercelProjectDetail = (input: ProjectInput) =>
	getVercelProjectDetail({ data: { ...input } }).pipe(Effect.mapError(toLoadFailure), Effect.result)

export const DEPLOYMENTS_LIMIT = 20

/** `integrations.vercelDeployments`: the project's newest deployments, from Vercel's API. */
export const loadVercelDeployments = (projectId: string) =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const response = yield* client.integrations.vercelDeployments({
			query: { projectId, limit: DEPLOYMENTS_LIMIT },
		})
		return response.deployments
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)
