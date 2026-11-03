import {
	CodeReviewAnalytics,
	CodeReviewCiAnalytics,
	CodeReviewCiRunsResponse,
	CodeReviewDetail,
	CodeReviewFindingsResponse,
	CodeReviewListResponse,
	CodeReviewTeam,
	GithubIntegrationStatus,
} from "@maple/domain/http"
import { Option, Schema } from "effect"
import { CACHE_TTL_MS, ResponseCache } from "./page-steps"

// What the Code Review tabs keep across a tab change: answers by request key for
// a minute after their last use. The tabs share one page instance, which carries these from the
// tab being left to the next one.

export const Retained = Schema.Struct({
	analytics: ResponseCache(CodeReviewAnalytics),
	ciAnalytics: ResponseCache(CodeReviewCiAnalytics),
	reviews: ResponseCache(CodeReviewListResponse),
	findings: ResponseCache(CodeReviewFindingsResponse),
	ciRuns: ResponseCache(CodeReviewCiRunsResponse),
	team: ResponseCache(CodeReviewTeam),
	details: ResponseCache(CodeReviewDetail),
	githubStatus: ResponseCache(GithubIntegrationStatus),
})
export type Retained = typeof Retained.Type

export const emptyRetained: Retained = {
	analytics: {},
	ciAnalytics: {},
	reviews: {},
	findings: {},
	ciRuns: {},
	team: {},
	details: {},
	githubStatus: {},
}

export const mergeRetained = (base: Retained, next: Partial<Retained>): Retained => ({
	analytics: { ...base.analytics, ...next.analytics },
	ciAnalytics: { ...base.ciAnalytics, ...next.ciAnalytics },
	reviews: { ...base.reviews, ...next.reviews },
	findings: { ...base.findings, ...next.findings },
	ciRuns: { ...base.ciRuns, ...next.ciRuns },
	team: { ...base.team, ...next.team },
	details: { ...base.details, ...next.details },
	githubStatus: { ...base.githubStatus, ...next.githubStatus },
})

/** The retained `integrations.githubStatus` answer under `key`, if it is still fresh at `nowMs`. */
export const retainedStatus = (
	retained: Retained,
	key: string,
	nowMs: number,
): Option.Option<GithubIntegrationStatus> => {
	const hit = retained.githubStatus[key]
	return hit !== undefined && nowMs - hit.usedAtMs <= CACHE_TTL_MS ? Option.some(hit.value) : Option.none()
}
