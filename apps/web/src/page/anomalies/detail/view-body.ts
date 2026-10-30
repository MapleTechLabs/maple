import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { formatNumber, pluralize } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { anomalyTimeseriesFromV2 } from "../../../lib/services/anomalies"
import { errorIssueFromV2 } from "../../../lib/services/error-issues"
import {
	deviation,
	formatSignalValue,
	isStaleOpenIncident,
	META_CHIP_CLASS,
	SIGNAL_LABEL,
	severityToneFor,
} from "@maple/web-data/anomalies/format"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { bucketTooltipBody } from "../../../charts/bucket-tooltip"
import type * as Chart from "../../../charts/chart"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { ChartSpec } from "../../../charts/chart-spec"
import { plotFrame } from "../../../charts/plot-frame"
import { resolveColor } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { card, cardPanel } from "../../../ui/card"
import { emptyMessage } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { pageTitle } from "../../../ui/page-layout"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { inlineCode } from "../../../ui/inline-code"
import { skeleton } from "../../../ui/skeleton"
import { chartError, chartLoading } from "../../../ui/chart-state"
import { serviceDot } from "../../../ui/values"
import { seriesLegend } from "../../kit/series-legend"
import { WORKFLOW_LABEL } from "../../errors/kit/workflow"
import { actorAvatar } from "../../errors/kit/actor"
import { shortIssueId } from "../kit/row"
import { Message } from "./message"
import type { Model } from "./model"

// `AnomalyHero`, `AnomalySignalChart` + `AnomalyTimeseriesChart` and `AnomalyLinkedIssueCard`.

type H = HtmlBuilder<Message>

export const CHART_TOKENS: ReadonlyArray<string> = [
	"--destructive",
	"--severity-error",
	"--severity-warn",
	"--muted-foreground",
	"--border",
	"--background",
]

const SEVERITY_STROKE = { critical: "--severity-error", warning: "--severity-warn" } as const

export const anomalyHero = (h: H, incident: AnomalyIncidentDocument, nowMs: number): Html => {
	const tone = severityToneFor(incident)
	const isStale = isStaleOpenIncident(incident, nowMs)
	const dev = deviation(incident)
	const accent = cn(
		"font-mono font-medium",
		incident.status === "open" && !isStale ? tone.text : "text-foreground",
	)
	const fmt = (value: number) => formatSignalValue(incident.signalType, value)
	return h.div(
		[h.Class("space-y-2")],
		[
			eyebrow(h, { as: "div" }, ["Anomaly"]),
			h.header(
				[h.Class("flex flex-wrap items-start gap-x-6 gap-y-3")],
				[
					h.div(
						[h.Class("min-w-0 flex-1 space-y-1")],
						[
							h.div(
								[h.Class("flex flex-wrap items-baseline gap-3")],
								[
									pageTitle(
										h,
										{
											title: `${SIGNAL_LABEL[incident.signalType]} · ${incident.serviceName}`,
											className:
												"min-w-0 whitespace-normal break-words text-foreground",
										},
										[
											SIGNAL_LABEL[incident.signalType],
											h.span([h.Class("text-muted-foreground/60")], [" · "]),
											incident.serviceName,
										],
									),
								],
							),
							h.p(
								[h.Class("max-w-2xl text-sm text-muted-foreground")],
								[
									isStale ? "Last recorded" : "Observed",
									" ",
									h.span([h.Class(accent)], [fmt(incident.lastObservedValue)]),
									" ",
									"against a ",
									h.span(
										[h.Class("font-mono text-foreground")],
										[fmt(incident.baselineMedian)],
									),
									" 7-day baseline:",
									" ",
									h.span([h.Class(accent)], [dev.label]),
									dev.kind === "sigma"
										? " above median"
										: dev.kind === "percent"
											? " vs baseline"
											: "",
									", threshold ",
									h.span(
										[h.Class("font-mono text-foreground")],
										[fmt(incident.thresholdValue)],
									),
									".",
									isStale
										? ` Last triggered ${formatRelativeTime(incident.lastTriggeredAt, nowMs)}; this stale detector state does not represent current service health.`
										: "",
								],
							),
						],
					),
				],
			),
		],
	)
}

const chartView = Submodel.defineView<Chart.Model, Chart.Message, Readonly<{ spec: ChartSpec }>>(
	(model, inputs, h) =>
		plotFrame(h, {
			chartId: "anomaly-signal",
			spec: inputs.spec,
			ariaLabel: "Observed signal",
			className: "h-64 w-full",
			tooltipBody: (portal) =>
				Option.flatMap(model.tooltip, (tooltip) =>
					tooltip._tag === "Bucket"
						? Option.some(bucketTooltipBody(h, tooltip, portal))
						: Option.none(),
				),
		}),
)

/** `AnomalySignalChart`: loading until the series, the theme and the chart runtime are all in. */
export const signalChart = (
	h: H,
	model: Model,
	incident: AnomalyIncidentDocument,
	timeZone: string,
): Html => {
	const colors = model.themeColors
	const isReady = colors !== null && isChartRuntimeReady(model.chartRuntime)
	return AsyncData.match(model.timeseries.data, {
		onIdle: () => chartLoading(h, { variant: "line", height: 256 }),
		onLoading: () => chartLoading(h, { variant: "line", height: 256 }),
		onFailure: () => chartError(h, { height: 256 }, ["Couldn't load signal data."]),
		onStale: () => chartError(h, { height: 256 }, ["Couldn't load signal data."]),
		onSuccess: (wire) => loaded(wire),
		onRefreshing: (wire) => loaded(wire),
	})
	function loaded(wire: Parameters<typeof anomalyTimeseriesFromV2>[0]): Html {
		if (!isReady || colors === null) return chartLoading(h, { variant: "line", height: 256 })
		const series = anomalyTimeseriesFromV2(wire)
		if (series.buckets.length === 0)
			return emptyMessage(
				h,
				{
					dashed: true,
					className: "flex h-64 w-full items-center justify-center border-border/60 py-0 text-xs",
				},
				["No signal data in window"],
			)
		const stroke = resolveColor(colors, SEVERITY_STROKE[incident.severity])
		// Both threshold rules draw in `--destructive`.
		const rule = resolveColor(colors, "--destructive")
		const fmt = (value: number) => formatSignalValue(series.signalType, value)
		return h.div(
			[h.Class("space-y-2")],
			[
				h.submodel({
					slotId: "anomaly-signal-chart",
					model: model.chart,
					view: chartView,
					viewInputs: {
						spec: ChartSpec.AnomalySignal({
							points: series.buckets.map((bucket) => ({
								bucket: bucket.bucket,
								value: bucket.value,
							})),
							signalType: series.signalType,
							baselineMedian: series.baselineMedian,
							thresholdValue: series.thresholdValue,
							firstTriggeredAt: incident.firstTriggeredAt,
							resolvedAt: incident.resolvedAt,
							colors: {
								stroke,
								muted: rule,
								threshold: rule,
								border: resolveColor(colors, "--border"),
								background: resolveColor(colors, "--background"),
							},
							gradientId: "anomaly-observed",
							timeZone,
						}),
					},
					toParentMessage: (message) => Message.GotChartMessage({ message }),
				}),
				seriesLegend(h, {
					className: "justify-start gap-x-4",
					swatch: "dashed",
					items: [
						{ key: "observed", label: "Observed", color: stroke, swatch: "line" },
						{
							key: "baseline",
							label: "Baseline median",
							value: fmt(series.baselineMedian),
							color: "var(--muted-foreground)",
						},
						{
							key: "threshold",
							label: "Threshold",
							value: fmt(series.thresholdValue),
							color: "var(--severity-error)",
						},
					],
				}),
			],
		)
	}
}

const IN_FLIGHT_SOFT = "bg-severity-debug/12 text-severity-debug"
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
	h.div(
		[h.Class("flex shrink-0 items-center gap-1.5")],
		[
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
		],
	)

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
			[h.Class("rounded-md border border-dashed border-border/60 p-4")],
			[
				h.div(
					[h.Class("flex flex-wrap items-center justify-between gap-3")],
					[
						h.div(
							[h.Class("space-y-1")],
							[
								h.p([h.Class("text-sm text-foreground")], ["Not linked to an issue"]),
								h.p(
									[h.Class("text-xs text-muted-foreground")],
									[
										incident.signalType === "error_spike"
											? "This frequency increase is fingerprint-scoped, so an issue with this fingerprint may already exist for the service."
											: "Escalate this anomaly by linking it to an existing error issue.",
									],
								),
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
					],
				),
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
		return h.div(
			[h.Class("flex items-center justify-between gap-3")],
			[
				h.p(
					[h.Class("text-muted-foreground")],
					[
						"Linked to issue",
						" ",
						h.code([h.Class("font-mono text-xs")], [shortIssueId(id)]),
						". Couldn't load its details.",
					],
				),
				cardActions(h, id, isBusy),
			],
		)
	}
	function loadedIssue(wire: Parameters<typeof errorIssueFromV2>[0]): Html {
		const issue = errorIssueFromV2(wire)
		const actor = issue.leaseHolder ?? issue.assignedActor
		return h.div(
			[h.Class("flex flex-wrap items-start justify-between gap-3")],
			[
				h.div(
					[h.Class("min-w-0 space-y-2")],
					[
						h.div(
							[h.Class("flex flex-wrap items-center gap-2")],
							[
								badge(
									h,
									{ variant: "outline", className: WORKFLOW_TONE[issue.workflowState] },
									[WORKFLOW_LABEL[issue.workflowState]],
								),
								h.code(
									[h.Class("font-mono text-xs tabular-nums text-muted-foreground")],
									[shortIssueId(issue.id)],
								),
								badge(
									h,
									{ variant: "meta", pill: true, size: "sm", className: META_CHIP_CLASS },
									[
										serviceDot(h, { serviceName: issue.serviceName, size: "sm" }),
										h.span([h.Class("max-w-[140px] truncate")], [issue.serviceName]),
									],
								),
							],
						),
						h.p(
							[h.Class("min-w-0 truncate font-medium text-foreground")],
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
						h.div(
							[h.Class("flex items-center gap-3 text-xs text-muted-foreground")],
							[
								h.span(
									[h.Class("tabular-nums")],
									[
										formatNumber(issue.occurrenceCount),
										" ",
										pluralize(issue.occurrenceCount, "event"),
									],
								),
								h.span(
									[h.Class("flex items-center gap-1.5")],
									actor === null ? ["Unclaimed"] : [actorAvatar(h, actor)],
								),
							],
						),
					],
				),
				cardActions(h, issue.id, isBusy),
			],
		)
	}
	return card(h, [cardPanel(h, [content], "space-y-3 p-4 text-sm")])
}
