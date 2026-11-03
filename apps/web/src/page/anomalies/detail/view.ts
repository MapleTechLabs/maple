import type { AnomalyIncidentDocument } from "@maple/domain/http"
import {
	isStaleOpenIncident,
	RESOLVE_REASON_LABEL,
	SEVERITY_TONE,
	severityToneFor,
} from "@maple/web-data/anomalies/format"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import type { BreadcrumbEntry } from "../../../shell"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { relativeTime } from "../../kit/relative-time"
import { resourceNotFound } from "../../kit/resource-not-found"
import { crumbOf, pageStateOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { detailTitleSkeleton } from "../../kit/detail-header"
import { anomalySummary, anomalyTitle, CHART_TOKENS, linkedIssueCard, signalChart } from "./view-body"
import { linkIssueDialog } from "./view-link-dialog"
import { anomalySidebar } from "./view-sidebar"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The anomaly detail page over `ResultPage`.

type H = HtmlBuilder<Message>

const headerActions = (h: H, model: Model, incident: AnomalyIncidentDocument, timeZone: string): Html => {
	const isOpen = incident.status === "open"
	const isStale = isStaleOpenIncident(incident, model.nowMs)
	const tone = severityToneFor(incident)
	const isBusy = model.busy !== null
	return hstack(h, { gap: "2" }, [
		badge(h, { variant: "outline", className: isStale ? SEVERITY_TONE.resolved.badge : tone.badge }, [
			...(isOpen && !isStale
				? [
						hstack(h, { gap: "1.5", as: "span" }, [
							statusDot(h, { tone: tone.tone }),
							incident.severity,
						]),
					]
				: isStale
					? [
							"Stale · last seen ",
							relativeTime(h, {
								value: incident.lastTriggeredAt,
								nowMs: model.nowMs,
								timeZone,
							}),
						]
					: [
							incident.resolveReason !== null
								? RESOLVE_REASON_LABEL[incident.resolveReason]
								: "Resolved",
						]),
		]),
		button(
			h,
			{
				size: "sm",
				variant: "outline",
				isDisabled: isBusy,
				isLoading: model.busy === "investigate",
				attributes: [h.OnClick(Message.ClickedInvestigate())],
			},
			[icon(h, "PulseIcon"), "Open investigation"],
		),
		...(isOpen
			? [
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isDisabled: isBusy,
							attributes: [h.OnClick(Message.ClickedResolve())],
						},
						["Resolve"],
					),
				]
			: []),
	])
}

const resolveDescription = (incident: AnomalyIncidentDocument): string =>
	`The incident is marked resolved manually${
		Arr.filter(incident.fingerprints, (f) => f.resolvedAt === null).length > 1
			? ", including every error fingerprint grouped into it"
			: ""
	}. If the signal keeps deviating, the detector waits out a one-hour cooldown before re-opening it.`

const loadedBody = (
	h: H,
	model: Model,
	incident: AnomalyIncidentDocument,
	timeZone: string,
): ReadonlyArray<Html> => {
	const isBusy = model.busy !== null
	return [
		h.div(
			[h.Class("space-y-8")],
			[
				h.section(
					[h.Class("space-y-4")],
					[anomalySummary(h, incident, model.nowMs), signalChart(h, model, incident, timeZone)],
				),
				h.section(
					[h.AriaLabelledBy("linked-issue-heading")],
					[
						eyebrow(
							h,
							{ as: "h2", className: "mb-3 block", attributes: [h.Id("linked-issue-heading")] },
							["Linked issue"],
						),
						linkedIssueCard(h, model, incident, isBusy),
					],
				),
			],
		),
		linkIssueDialog(h, model, incident, timeZone),
		confirmDialog(h, {
			slotId: "anomaly-resolve-dialog",
			model: model.resolveDialog,
			toParentMessage: (message) => Message.GotResolveDialogMessage({ message }),
			tone: "default",
			hasIcon: false,
			title: "Resolve this anomaly?",
			description: resolveDescription(incident),
			confirmLabel: "Resolve",
			isPending: isBusy,
			onConfirm: Message.ClickedConfirmResolve(),
		}),
	]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	const state = pageStateOf(model)
	const page =
		state._tag === "Loaded"
			? dashboardPage(
					h,
					{
						titleContent: anomalyTitle(h, state.incident),
						actions: headerActions(h, model, state.incident, timeZone),
						rightPanel: anomalySidebar(h, {
							incident: state.incident,
							isBusy: model.busy !== null,
							nowMs: model.nowMs,
							timeZone,
						}),
					},
					loadedBody(h, model, state.incident, timeZone),
				)
			: state._tag === "NotFound"
				? dashboardPage(h, {}, [
						resourceNotFound(h, {
							title: "Anomaly not found",
							description: "It may have been pruned, or the link is stale.",
							back: { href: "/anomalies", label: "Back to anomalies" },
						}),
					])
				: state._tag === "Failed"
					? dashboardPage(h, {}, [
							errorState(h, {
								failure: state.failure,
								title: "Couldn't load anomaly",
								onRetry: Message.ClickedRetry(),
							}),
						])
					: dashboardPage(h, { titleContent: detailTitleSkeleton(h, false) }, [
							h.div(
								[h.Class("space-y-4")],
								[
									skeleton(h, "h-5 w-2/3"),
									skeleton(h, "h-64 w-full"),
									skeleton(h, "h-32 w-full"),
								],
							),
						])
	return h.div([h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: CHART_TOKENS }))], [page])
})

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => {
	const state = pageStateOf(model)
	return [
		{ label: "Anomalies", href: "/anomalies" },
		{
			label:
				state._tag === "Loaded"
					? crumbOf(state.incident)
					: state._tag === "NotFound"
						? "Not found"
						: state._tag === "Failed"
							? "Error"
							: "Loading…",
		},
	]
}
