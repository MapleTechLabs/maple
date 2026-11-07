import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { formatNumber, pluralize } from "@maple/ui/lib/format"
import { errorIssueFromV2 } from "../../../lib/services/error-issues"
import { META_CHIP_CLASS, SIGNAL_LABEL } from "@maple/web-data/anomalies/format"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { card, cardPanel } from "@maple/views/ui/card"
import { detailTitle } from "../../kit/detail-header"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { inlineCode } from "@maple/views/ui/inline-code"
import { skeleton } from "@maple/views/ui/skeleton"
import { serviceDot } from "@maple/views/ui/values"
import { WORKFLOW_LABEL } from "../../errors/kit/workflow"
import { actorAvatar } from "../../errors/kit/actor"
import { ANOMALY_CHART_TOKENS, anomalySignalChart } from "../kit/evidence"
import { shortIssueId } from "../kit/row"
import { Message } from "./message"
import type { Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"

// `AnomalyHero`, `AnomalySignalChart` + `AnomalyTimeseriesChart` and `AnomalyLinkedIssueCard`.

type H = HtmlBuilder<Message>

/** The theme tokens the signal chart reads. */
export const CHART_TOKENS = ANOMALY_CHART_TOKENS

/** The detail header's title side: the signal and service under the "Anomaly" eyebrow. */
export const anomalyTitle = (h: H, incident: AnomalyIncidentDocument): Html =>
	detailTitle(h, {
		kind: ["Anomaly"],
		title: [
			SIGNAL_LABEL[incident.signalType],
			typography(h, { tone: "subtle" }, [" · "]),
			incident.serviceName,
		],
		titleText: `${SIGNAL_LABEL[incident.signalType]} · ${incident.serviceName}`,
	})

/** `AnomalySignalChart` over the page's series, theme and chart runtime. */
export const signalChart = (h: H, model: Model, incident: AnomalyIncidentDocument, timeZone: string): Html =>
	anomalySignalChart(h, {
		chartId: "anomaly-signal",
		chart: model.chart,
		toChartMessage: (message) => Message.GotChartMessage({ message }),
		timeseries: model.timeseries.data,
		incident,
		colors: model.themeColors,
		chartRuntime: model.chartRuntime,
		timeZone,
	})

const IN_FLIGHT_SOFT = "bg-severity-debug-a2 text-severity-debug"
const WORKFLOW_TONE = {
	triage: TONE_SOFT.warn,
	regressed: TONE_SOFT.crit,
	todo: TONE_SOFT.neutral,
	in_progress: IN_FLIGHT_SOFT,
	in_review: IN_FLIGHT_SOFT,
	verifying: IN_FLIGHT_SOFT,
	done: TONE_SOFT.done,
	cancelled: TONE_SOFT.neutral,
	wontfix: TONE_SOFT.neutral,
} as const

const cardActions = (
	h: H,
	issueId: NonNullable<AnomalyIncidentDocument["errorIssueId"]>,
	isBusy: boolean,
): Html =>
	hstack(h, { gap: "1.5", className: "shrink-0" }, [
		linkButton(
			h,
			{
				size: "sm",
				variant: "outline",
				href: hrefOf(AppRoute.ErrorIssue({ issueId, search: {} })),
			},
			["Open issue", icon(h, "ArrowRightIcon")],
		),
		iconButton(
			h,
			{
				label: "Link a different issue",
				isDisabled: isBusy,
				attributes: [h.OnClick(Message.ClickedLinkIssue())],
			},
			[icon(h, "LinkIcon")],
		),
		iconButton(
			h,
			{
				label: "Unlink issue",
				isDisabled: isBusy,
				attributes: [h.OnClick(Message.ClickedUnlink())],
			},
			[icon(h, "XmarkIcon")],
		),
	])

/** `AnomalyLinkedIssueCard`. */
export const linkedIssueCard = (
	h: H,
	model: Model,
	incident: AnomalyIncidentDocument,
	isBusy: boolean,
): Html => {
	const issueId = incident.errorIssueId
	if (issueId === null)
		return h.div(
			[h.Class("rounded-md border border-dashed border-border-subtle p-4")],
			[
				hstack(h, { gap: "3", justify: "between", wrap: true }, [
					h.div(
						[h.Class("space-y-1")],
						[
							typography(h, { size: "sm", tone: "foreground", as: "p" }, [
								"Not linked to an issue",
							]),
							typography(h, { size: "xs", tone: "muted", as: "p" }, [
								incident.signalType === "error_spike"
									? "This frequency increase is fingerprint-scoped, so an issue with this fingerprint may already exist for the service."
									: "Escalate this anomaly by linking it to an existing error issue.",
							]),
							...(incident.fingerprintHash === null
								? []
								: [
										inlineCode(
											h,
											{
												className:
													"inline-block px-1.5 py-0.5 text-2xs text-muted-foreground",
											},
											["fingerprint ", incident.fingerprintHash],
										),
									]),
						],
					),
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isDisabled: isBusy,
							attributes: [h.OnClick(Message.ClickedLinkIssue())],
						},
						[icon(h, "LinkIcon"), "Link issue"],
					),
				]),
			],
		)
	const content = AsyncData.match(model.linkedIssue.data, {
		onIdle: () => skeleton(h, "h-12 w-full"),
		onLoading: () => skeleton(h, "h-12 w-full"),
		onFailure: () => failedIssue(issueId),
		onStale: () => failedIssue(issueId),
		onSuccess: (wire) => loadedIssue(wire),
		onRefreshing: (wire) => loadedIssue(wire),
	})
	function failedIssue(id: NonNullable<AnomalyIncidentDocument["errorIssueId"]>): Html {
		return hstack(h, { gap: "3", justify: "between" }, [
			typography(h, { tone: "muted", as: "p" }, [
				"Linked to issue",
				" ",
				h.code([h.Class(typographyClass({ size: "xs", mono: true }))], [shortIssueId(id)]),
				". Couldn't load its details.",
			]),
			cardActions(h, id, isBusy),
		])
	}
	function loadedIssue(wire: Parameters<typeof errorIssueFromV2>[0]): Html {
		const issue = errorIssueFromV2(wire)
		const actor = issue.leaseHolder ?? issue.assignedActor
		return hstack(h, { gap: "3", align: "start", justify: "between", wrap: true }, [
			h.div(
				[h.Class("min-w-0 space-y-2")],
				[
					hstack(h, { gap: "2", wrap: true }, [
						badge(h, { variant: "outline", className: WORKFLOW_TONE[issue.workflowState] }, [
							WORKFLOW_LABEL[issue.workflowState],
						]),
						h.code(
							[
								h.Class(
									typographyClass({
										size: "xs",
										tone: "muted",
										mono: true,
										numeric: true,
									}),
								),
							],
							[shortIssueId(issue.id)],
						),
						badge(h, { variant: "meta", pill: true, size: "sm", className: META_CHIP_CLASS }, [
							serviceDot(h, { serviceName: issue.serviceName, size: "sm" }),
							h.span([h.Class("max-w-[140px] truncate")], [issue.serviceName]),
						]),
					]),
					typography(
						h,
						{
							tone: "foreground",
							weight: "medium",
							truncate: true,
							as: "p",
							className: "min-w-0",
						},
						[
							issue.exceptionType || "Unknown error",
							...(issue.exceptionMessage
								? [
										h.span(
											[h.Class("ml-2 font-normal text-muted-foreground")],
											[issue.exceptionMessage],
										),
									]
								: []),
						],
					),
					hstack(h, { gap: "3", className: typographyClass({ size: "xs", tone: "muted" }) }, [
						typography(h, { numeric: true }, [
							formatNumber(issue.occurrenceCount),
							" ",
							pluralize(issue.occurrenceCount, "event"),
						]),
						hstack(
							h,
							{ gap: "1.5", as: "span" },
							actor === null ? ["Unclaimed"] : [actorAvatar(h, actor)],
						),
					]),
				],
			),
			cardActions(h, issue.id, isBusy),
		])
	}
	return card(h, [cardPanel(h, [content], "space-y-3 p-4 text-sm")])
}
