import type { ErrorIssueDetailResponse } from "@maple/domain/http"
import { errorIssueDetailFromV2 } from "@maple/web/lib/services/error-issues"
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
import { Message } from "./message"
import type { Model } from "./model"
import { occurrencePanel, OCCURRENCE_TOKENS } from "./view-chart"
import { headerActions, headerTitle, issueTabs } from "./view-header"
import { culpritPanel, issueFactStrip } from "./view-overview"
import {
	attachNudge,
	bodySection,
	incidentsTable,
	linkedInvestigationPanel,
	pullRequestsPanel,
} from "./view-panels"
import { issueSidebar } from "./view-sidebar"
import { relatedAnomaliesOf, relatedAnomaliesSection } from "./view-anomalies"
import { issueSkeleton, issueNotFound } from "./view-skeleton"

// `IssueDetailContent`: skeleton, not-found and error states, then the loaded page.

type H = HtmlBuilder<Message>

/** States where somebody has taken the issue on, so a missing pull request is worth pointing at. */
const AWAITING_FIX_STATES = new Set(["in_progress", "in_review"])

const overview = (h: H, model: Model, detail: ErrorIssueDetailResponse, inputs: PageViewInputs): Html => {
	const { issue, timeseries, incidents } = detail
	const chartWindow = model.window === null ? null : chartWindowOf(model.window)
	return h.div(
		[h.Class("flex flex-col gap-7")],
		[
			culpritPanel(h, model, issue),
			issueFactStrip(h, issue, {
				windowCount: timeseries.reduce((sum, bucket) => sum + bucket.count, 0),
				windowLabel: windowLabel(model.search),
				timeZone: inputs.context.timeZone,
				nowMs: model.nowMs,
			}),
			// TODO(alert-source): alert-kind issues show `AlertSourceCard` instead of the chart.
			...(chartWindow === null || model.themeColors === null || model.chartRuntime._tag === "Loading"
				? []
				: [
						occurrencePanel(
							h,
							timeseries,
							issue.severity,
							chartWindow,
							model.themeColors,
							inputs.context.timeZone,
						),
					]),
			linkedInvestigationPanel(h, linkedInvestigationOf(model), model.isStartingInvestigation),
			...(issue.kind === "error"
				? [
						bodySection(
							h,
							{
								id: "incidents",
								title: "Incidents",
								count: incidents.length === 0 ? undefined : `${incidents.length} opened`,
							},
							[incidentsTable(h, incidents)],
						),
					]
				: []),
			...relatedAnomaliesSection(h, relatedAnomaliesOf(model), {
				nowMs: model.nowMs,
				timeZone: inputs.context.timeZone,
			}),
		],
	)
}

const rightPanel = (h: H, model: Model, detail: ErrorIssueDetailResponse): Html => {
	const verification = latestVerificationOf(model)
	const pullRequests = pullRequestsOf(model)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			issueSidebar(h, model, detail.issue, detail.environments),
			h.div(
				[h.Class("flex flex-col gap-4 px-4 pb-4")],
				[
					// TODO(verification-card): `IssueVerificationCard` while a fix is being verified.
					...(verification === null &&
					AWAITING_FIX_STATES.has(detail.issue.workflowState) &&
					pullRequests.length === 0
						? [attachNudge(h)]
						: []),
					pullRequestsPanel(h, pullRequests),
				],
			),
		],
	)
}

/** TODO(tabs): the Occurrences table and the Activity timeline with its composer. */
const otherTab = (h: H, tab: "occurrences" | "activity", detail: ErrorIssueDetailResponse): Html =>
	tab === "occurrences"
		? bodySection(
				h,
				{
					id: "occurrences",
					title: "Latest occurrences",
					count:
						detail.sampleTraces.length === 0
							? undefined
							: `${detail.sampleTraces.length} sampled in this window`,
				},
				[],
			)
		: bodySection(h, { id: "activity", title: "Activity" }, [])

const loaded = (h: H, model: Model, detail: ErrorIssueDetailResponse, inputs: PageViewInputs): Html => {
	const investigation = linkedInvestigationOf(model)
	const tab = tabOf(model.search)
	return dashboardPage(
		h,
		{
			titleContent: headerTitle(h, detail.issue, investigation, relatedAnomaliesOf(model)),
			actions: headerActions(h, model, investigation),
			tabs: issueTabs(h, model.issueId, model.search, {
				active: tab,
				showOccurrences: detail.issue.kind === "error",
				occurrenceCount: detail.sampleTraces.length,
				activityCount: eventCountOf(model) + escalationsOf(model).length,
			}),
			rightPanel: rightPanel(h, model, detail),
		},
		[
			tab === "overview" ? overview(h, model, detail, inputs) : otherTab(h, tab, detail),
			severityConfirmDialog(h, model),
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
									title: "Failed to load issue",
									onRetry: Message.ClickedRetry(),
								}),
							]),
				onData: (v2) => loaded(h, model, errorIssueDetailFromV2(v2), inputs),
			}),
		],
	),
)
