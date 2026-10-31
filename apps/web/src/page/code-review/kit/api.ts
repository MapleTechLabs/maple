import type {
	CodeReviewAnalyticsQuery,
	CodeReviewCiQuery,
	CodeReviewCiRunsQuery,
	CodeReviewFindingsQuery,
	CodeReviewListQuery,
	CodeReviewTeamQuery,
	PrReviewId,
} from "@maple/domain/http"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { Effect } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import type { TimeWindow } from "../../../data/time-range"
import { MapleInternalApiClient } from "../../../platform/api-clients"

// The `codeReview` reads every tab sends (`retainedInternalQuery("codeReview", ...)`), as Effects
// their Commands wrap; failures become the `displayError` body.

/** The resolved window, epoch ms, as the code review queries take it. */
export const epochWindow = (window: TimeWindow) => ({
	startTime: toEpochMs(window.startTime),
	endTime: toEpochMs(window.endTime),
})

type Api = typeof MapleInternalApiClient.Service

const call = <A, E, R>(run: (api: Api) => Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const api = yield* MapleInternalApiClient
		return yield* run(api)
	}).pipe(Effect.mapError(toLoadFailure))

export const getAnalytics = (query: CodeReviewAnalyticsQuery) =>
	call((api) => api.codeReview.analytics({ query }))

export const listReviews = (query: CodeReviewListQuery) =>
	call((api) => api.codeReview.listReviews({ query }))

export const listFindings = (query: CodeReviewFindingsQuery) =>
	call((api) => api.codeReview.listFindings({ query }))

export const getReview = (reviewId: PrReviewId) =>
	call((api) => api.codeReview.getReview({ params: { reviewId } }))

export const getCiAnalytics = (query: CodeReviewCiQuery) =>
	call((api) => api.codeReview.ciAnalytics({ query }))

export const listCiRuns = (query: CodeReviewCiRunsQuery) => call((api) => api.codeReview.ciRuns({ query }))

export const getTeam = (query: CodeReviewTeamQuery) => call((api) => api.codeReview.team({ query }))
