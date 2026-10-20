import type { ErrorIssueDetailResponse, ErrorIssueDocument } from "@maple/domain/http"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import { errorIssueDetailFromV2 } from "../../../lib/services/error-issues"
import { AlertIncidentId } from "@maple/domain/primitives"
import type { V2InvestigationCreateParams } from "@maple/domain/http/v2"
import { DateTime, Option, Schema } from "effect"
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

/** `issueHeadline`: what the issue is called, for a human and for an agent. */
const issueHeadline = (issue: ErrorIssueDocument): string =>
	issue.exceptionType && issue.exceptionMessage
		? `${issue.exceptionType}: ${issue.exceptionMessage}`
		: issue.exceptionType || issue.exceptionMessage || issue.errorLabel || "Unlabelled error"

const decodeAlertIncidentId = Schema.decodeUnknownOption(AlertIncidentId)

/** `latestIncidentId` and `startInvestigation`'s subject: the open incident if there is one, else freeform. */
const subjectOf = (detail: ErrorIssueDetailResponse): V2InvestigationCreateParams["subject"] => {
	const { issue, incidents } = detail
	const title = issueHeadline(issue)
	const freeform = {
		type: "freeform" as const,
		title,
		prompt: `Investigate this issue: ${title}`,
		context_refs: [{ issue_id: issue.id }],
	}
	if (issue.kind === "alert") {
		const raw = issue.sourceRef?.latestIncidentId
		return Option.match(decodeAlertIncidentId(raw), {
			onNone: () => freeform,
			onSome: (incidentId) => ({
				type: "incident" as const,
				incident_kind: "alert" as const,
				incident_id: incidentId,
				issue_id: issue.id,
			}),
		})
	}
	const incident = incidents.find((candidate) => candidate.status === "open") ?? incidents[0]
	return incident === undefined
		? freeform
		: { type: "incident", incident_kind: "error", incident_id: incident.id, issue_id: issue.id }
}

/** The `investigations.create` payload `startInvestigation` sends. */
export const investigationPayload = (detail: ErrorIssueDetailResponse): V2InvestigationCreateParams => {
	const { issue } = detail
	const title = issueHeadline(issue)
	return {
		subject: subjectOf(detail),
		snapshot: {
			title,
			scope: issue.serviceName || null,
			status: "open",
			severity: issue.severity,
			facts: [
				{ label: "Service", value: issue.serviceName || "unknown" },
				{ label: "Occurrences", value: String(issue.occurrenceCount) },
				...(issue.exceptionType ? [{ label: "Exception", value: issue.exceptionType }] : []),
				...(issue.topFrame ? [{ label: "Top frame", value: issue.topFrame }] : []),
			],
			references: [{ label: "Issue", url: `/errors/issues/${issue.id}` }],
			incidentStartedAt: issue.firstSeenAt,
			incidentEndedAt: issue.lastSeenAt,
			fingerprintHash: issue.fingerprintHash || null,
			exceptionType: issue.exceptionType || null,
			exceptionMessage: issue.exceptionMessage || null,
			topFrame: issue.topFrame || null,
			errorLabel: issue.errorLabel || null,
			occurrenceCount: issue.occurrenceCount,
			serviceName: issue.serviceName || null,
		},
	}
}
