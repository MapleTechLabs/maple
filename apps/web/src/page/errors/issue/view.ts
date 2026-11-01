import type { ErrorIssueDetailResponse } from "@maple/domain/http"
import { errorIssueDetailFromV2 } from "../../../lib/services/error-issues"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { errorState } from "../../../ui/error-state"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import {
	chartWindowOf,
	escalationsOf,
	eventCountOf,
	latestVerificationOf,
	linkedInvestigationOf,
	pullRequestsOf,
	tabOf,
	windowLabel,
} from "./derive"
import { MountRightRail } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { occurrencePanel, OCCURRENCE_TOKENS, signalOf } from "./view-chart"
import { headerActions, headerTitle, issueTabs } from "./view-header"
import { exceptionPanel, issueStats } from "./view-overview"
import { getItFixedPanel } from "./view-agent-handoff"
import { alertSourceCard, attachNudge, bodySection, pullRequestsPanel } from "./view-panels"
import { issueSidebar } from "./view-sidebar"
import { attachDialog } from "./attach"
import { verificationCard } from "./view-verification"
import { incidentsTable, occurrencesTable } from "./view-tables"
import { commentComposer, issueTimeline } from "./view-activity"
import { skeleton } from "../../../ui/skeleton"
import { panel, panelHeader } from "../../../ui/panel"
import { textLinkClass } from "../../../ui/text-link"
import { AppRoute, hrefOf } from "../../../route"
import { relatedAnomaliesOf, relatedAnomaliesSection } from "./view-anomalies"
import { issueSkeleton, issueNotFound } from "./view-skeleton"

// `IssueDetailContent`: skeleton, not-found and error states, then the loaded page.

type H = HtmlBuilder<Message>

/** States where somebody has taken the issue on, so a missing pull request is worth pointing at. */
const AWAITING_FIX_STATES = new Set(["in_progress", "in_review"])

/** The latest few samples inline, with the way to all of them. */
const latestOccurrences = (
	h: H,
	model: Model,
	detail: ErrorIssueDetailResponse,
	clock: Readonly<{ nowMs: number; timeZone: string }>,
): ReadonlyArray<Html> =>
	detail.sampleTraces.length === 0
		? []
		: [
				panel(h, { className: "shrink-0 overflow-hidden" }, [
					panelHeader(h, {
						title: "Latest occurrences",
						action: h.a(
							[
								h.Href(
									hrefOf(
										AppRoute.ErrorIssue({
											issueId: model.issueId,
											search: { ...model.search, tab: "occurrences" },
										}),
									),
								),
								h.Class(textLinkClass("muted", false, "text-xs")),
							],
							[`All ${detail.sampleTraces.length} samples`],
						),
					}),
					occurrencesTable(h, detail.sampleTraces.slice(0, LATEST_OCCURRENCES), clock),
				]),
			]

const LATEST_OCCURRENCES = 3

/** Incidents as a panel; one quiet line while there are none. */
const incidentsPanel = (
	h: H,
	detail: ErrorIssueDetailResponse,
	clock: Readonly<{ nowMs: number; timeZone: string }>,
): Html =>
	panel(h, { className: "shrink-0 overflow-hidden" }, [
		panelHeader(h, {
			title: "Incidents",
			scope:
				detail.incidents.length === 0
					? undefined
					: h.span(
							[h.Class("text-2xs text-muted-foreground tabular-nums")],
							[`${detail.incidents.length} opened`],
						),
		}),
		detail.incidents.length === 0
			? h.p(
					[h.Class("px-4 py-3 text-xs text-muted-foreground")],
					[
						"None in this window. An incident opens when the error is first seen or comes back after a fix.",
					],
				)
			: incidentsTable(h, detail.incidents, clock),
	])

type Signal = ReturnType<typeof signalOf>

const signalOfDetail = (model: Model, detail: ErrorIssueDetailResponse): Signal | null =>
	model.window === null ? null : signalOf(detail.timeseries, chartWindowOf(model.window))

/** The occurrences chart, or its frame while the theme and the chart runtime load. */
const chartSlot = (h: H, model: Model, detail: ErrorIssueDetailResponse, timeZone: string): Html => {
	const chartWindow = model.window === null ? null : chartWindowOf(model.window)
	return chartWindow === null || model.themeColors === null || model.chartRuntime._tag === "Loading"
		? panel(h, { className: "shrink-0 overflow-hidden" }, [
				panelHeader(h, { title: "Occurrences" }),
				h.div([h.Class("px-4 pt-3 pb-4")], [skeleton(h, "h-44 w-full rounded-md")]),
			])
		: occurrencePanel(
				h,
				model.chart,
				detail.timeseries,
				detail.issue.severity,
				chartWindow,
				model.themeColors,
				timeZone,
			)
}

const overview = (
	h: H,
	model: Model,
	detail: ErrorIssueDetailResponse,
	signal: Signal | null,
	inputs: PageViewInputs,
): Html => {
	const { issue, timeseries } = detail
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	const stats = issueStats(h, issue, {
		windowCount: timeseries.reduce((sum, bucket) => sum + bucket.count, 0),
		windowLabel: windowLabel(model.search),
		spark: signal?.dense ?? [],
		surge: signal?.surge ?? null,
		...clock,
	})
	const fix = getItFixedPanel(h, model, issue, linkedInvestigationOf(model))
	return h.div(
		[h.Class("flex flex-col gap-4")],
		issue.kind === "alert"
			? [
					alertSourceCard(h, issue),
					stats,
					fix,
					...relatedAnomaliesSection(h, relatedAnomaliesOf(model), clock),
				]
			: [
					exceptionPanel(h, model, issue),
					stats,
					fix,
					chartSlot(h, model, detail, inputs.context.timeZone),
					...latestOccurrences(h, model, detail, clock),
					incidentsPanel(h, detail, clock),
					...relatedAnomaliesSection(h, relatedAnomaliesOf(model), clock),
				],
	)
}

const rightPanel = (h: H, model: Model, detail: ErrorIssueDetailResponse): Html => {
	const verification = latestVerificationOf(model)
	const pullRequests = pullRequestsOf(model)
	return h.div(
		[h.Class("flex flex-col gap-4"), h.OnMount(MountRightRail())],
		[
			issueSidebar(h, model, detail.issue, detail.environments),
			h.div(
				[h.Class("flex flex-col gap-4 px-4 pb-4")],
				[
					...(verification !== null
						? [verificationCard(h, verification, detail.issue.workflowState, model.nowMs)]
						: AWAITING_FIX_STATES.has(detail.issue.workflowState) && pullRequests.length === 0
							? [attachNudge(h)]
							: []),
					pullRequestsPanel(h, pullRequests, model.isAttaching || model.isDetaching),
				],
			),
		],
	)
}

/** The Occurrences table, or the Activity timeline with its composer. */
const otherTab = (
	h: H,
	model: Model,
	tab: "occurrences" | "activity",
	detail: ErrorIssueDetailResponse,
	inputs: PageViewInputs,
): Html => {
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	if (tab === "occurrences")
		return bodySection(
			h,
			{
				id: "occurrences",
				title: "Latest occurrences",
				count:
					detail.sampleTraces.length === 0
						? undefined
						: `${detail.sampleTraces.length} sampled in this window`,
			},
			[occurrencesTable(h, detail.sampleTraces, clock)],
		)
	const events = Option.getOrNull(AsyncData.getData(model.events.data))?.events ?? []
	const { issue } = detail
	// Everyone who has acted on the issue, newest first.
	const participants = [
		...(issue.leaseHolder ? [issue.leaseHolder] : []),
		...(issue.assignedActor ? [issue.assignedActor] : []),
		...[...events].reverse().flatMap((event) => (event.actor ? [event.actor] : [])),
	]
	return bodySection(h, { id: "activity", title: "Activity" }, [
		AsyncData.matchData(model.events.data, {
			onEmpty: () => skeleton(h, "h-20 w-full"),
			onFailure: (failure) =>
				errorState(h, {
					failure,
					title: "Couldn't load the activity timeline",
					variant: "inline",
					onRetry: Message.ClickedRetryEvents(),
				}),
			onData: (value) =>
				issueTimeline(h, value.events, escalationsOf(model), clock, model.isShowingEarlier),
		}),
		commentComposer(h, { draft: model.commentDraft, isPosting: model.isCommenting, participants }),
	])
}

const loaded = (h: H, model: Model, detail: ErrorIssueDetailResponse, inputs: PageViewInputs): Html => {
	const investigation = linkedInvestigationOf(model)
	const tab = tabOf(model.search)
	const signal = signalOfDetail(model, detail)
	return dashboardPage(
		h,
		{
			titleContent: headerTitle(
				h,
				detail.issue,
				investigation,
				relatedAnomaliesOf(model),
				signal?.surge ?? null,
			),
			actions: headerActions(h, model, detail.issue),
			tabs: issueTabs(h, model.issueId, model.search, {
				active: tab,
				showOccurrences: detail.issue.kind === "error",
				occurrenceCount: detail.sampleTraces.length,
				activityCount: eventCountOf(model) + escalationsOf(model).length,
			}),
			rightPanel: rightPanel(h, model, detail),
		},
		[
			tab === "overview"
				? overview(h, model, detail, signal, inputs)
				: otherTab(h, model, tab, detail, inputs),
			severityConfirmDialog(h, model),
			attachDialog(h, model),
		],
	)
}

/** "Notify escalation destinations?" before a manual severity raise that routes. */
const severityConfirmDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: "issue-severity-confirm",
		model: model.severityConfirm,
		toParentMessage: (message) => Message.GotSeverityConfirmMessage({ message }),
		tone: "default",
		hasIcon: false,
		title: "Notify escalation destinations?",
		description: [
			"Changing severity to ",
			model.pendingSeverity?.severity ?? "",
			" will notify",
			" ",
			model.pendingSeverity?.destinationNames.join(", ") ?? "",
			". Manual severity changes represent explicit human intent and bypass AI confidence gates.",
		],
		confirmLabel: "Change severity and notify",
		onConfirm: Message.ClickedConfirmSeverity(),
	})

const isNotFound = (failure: { readonly _tag: string }) =>
	failure._tag === "@maple/http/errors/ErrorIssueNotFoundError"

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: OCCURRENCE_TOKENS }))],
		[
			AsyncData.matchData(model.detail.data, {
				onEmpty: () => issueSkeleton(h, model),
				onFailure: (failure) =>
					isNotFound(failure)
						? issueNotFound(h)
						: dashboardPage(h, {}, [
								errorState(h, {
									failure,
									title: "Couldn't load issue",
									onRetry: Message.ClickedRetry(),
								}),
							]),
				onData: (v2) => loaded(h, model, errorIssueDetailFromV2(v2), inputs),
			}),
		],
	),
)
