import type { ErrorIssueDetailResponse, ErrorIssueDocument } from "@maple/domain/http"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import { errorIssueDetailFromV2 } from "@maple/web/lib/services/error-issues"
import { DateTime, Option } from "effect"
import { AsyncData } from "foldkit"
import type { TimeWindow } from "../../../data/time-range"
import type { ErrorIssueSearch } from "../../../route/search"
import type { DetailQuery } from "./command"
import type { Model } from "./model"

export type Search = typeof ErrorIssueSearch.Type

/** The detail page's default window (`DEFAULT_PRESET`). */
export const DEFAULT_PRESET = "12h"
/** How many buckets the detail chart gets, and the endpoint's bounds on `bucket_seconds`. */
const CHART_BUCKETS = 48
const MIN_BUCKET_SECONDS = 60
const MAX_BUCKET_SECONDS = 86_400
const SAMPLE_LIMIT = 50

export type Tab = "overview" | "occurrences" | "activity"
export const tabOf = (search: Search): Tab => search.tab ?? "overview"

const warehouseMs = (value: string): number | null =>
	Option.getOrNull(Option.map(DateTime.make(value.replace(" ", "T") + "Z"), DateTime.toEpochMillis))

export type ChartWindow = Readonly<{
	startMs: number
	endMs: number
	bucketMs: number
	bucketSeconds: number
}>

/** `chartWindow`: the window and its bucket width, 48 buckets clamped to what the endpoint takes. */
export const chartWindowOf = (window: TimeWindow): ChartWindow => {
	const startMs = warehouseMs(window.startTime)
	const endMs = warehouseMs(window.endTime)
	const spanSeconds =
		startMs !== null && endMs !== null && endMs > startMs ? (endMs - startMs) / 1000 : 12 * 3600
	const bucketSeconds = Math.min(
		MAX_BUCKET_SECONDS,
		Math.max(MIN_BUCKET_SECONDS, Math.round(spanSeconds / CHART_BUCKETS)),
	)
	return { startMs: startMs ?? 0, endMs: endMs ?? 0, bucketMs: bucketSeconds * 1000, bucketSeconds }
}

/** `detailQuery`: the v2 contract takes ISO, the window is warehouse format. */
export const detailQueryOf = (window: TimeWindow): DetailQuery => ({
	start_time: warehouseDateTimeToIso(window.startTime),
	end_time: warehouseDateTimeToIso(window.endTime),
	bucket_seconds: chartWindowOf(window).bucketSeconds,
	sample_limit: SAMPLE_LIMIT,
})

/** Names the window the fact strip's "Events" lane is counting over. */
export const windowLabel = (search: Search): string =>
	search.startTime && !search.timePreset ? "selected range" : (search.timePreset ?? DEFAULT_PRESET)

export const detailOf = (model: Model): Option.Option<ErrorIssueDetailResponse> =>
	Option.map(AsyncData.getData(model.detail.data), errorIssueDetailFromV2)

/** The header's title: type, else label. */
export const headlineOf = (issue: ErrorIssueDocument): string =>
	issue.exceptionType || issue.errorLabel || "Unlabelled error"

const dataOr = <A, E>(data: AsyncData.AsyncData<A, E>, fallback: A): A =>
	Option.getOrElse(AsyncData.getData(data), () => fallback)

export const linkedInvestigationOf = (model: Model) => dataOr(model.investigations.data, [])[0] ?? null
export const eventCountOf = (model: Model): number => dataOr(model.events.data, null)?.events.length ?? 0
export const escalationsOf = (model: Model) => dataOr(model.escalations.data, null)?.attempts ?? []
export const pullRequestsOf = (model: Model) => dataOr(model.pullRequests.data, null)?.pullRequests ?? []
export const latestVerificationOf = (model: Model) =>
	dataOr(model.verifications.data, null)?.verifications[0] ?? null
