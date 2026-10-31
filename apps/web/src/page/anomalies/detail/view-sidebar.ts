import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	deviation,
	formatSignalValue,
	isStaleOpenIncident,
	META_CHIP_CLASS,
	RESOLVE_REASON_LABEL,
	SIGNAL_LABEL,
	severityToneFor,
	TRIAGE_STATUS_CHIP,
} from "@maple/web-data/anomalies/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "../../../ui/button"
import { detailRailGroup, detailRailRow } from "../../../ui/detail-rail"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { statusDot } from "../../../ui/status-dot"
import { truncatedId } from "../../../ui/truncated-id"
import { serviceDot } from "../../../ui/values"
import { relativeTime } from "../../kit/relative-time"
import { shortIssueId } from "../kit/row"
import { Message } from "./message"

// `AnomalySidebar`: the anomaly detail's side rail.

type H = HtmlBuilder<Message>

export type SidebarInput = Readonly<{
	incident: AnomalyIncidentDocument
	isBusy: boolean
	nowMs: number
	timeZone: string
}>

const row = (h: H, label: string, children: ReadonlyArray<Html | string>, title?: string): Html =>
	detailRailRow(h, { label, title }, children)

const mono = (h: H, value: string, className: string): Html =>
	h.span([h.Class(cn("font-mono text-sm tabular-nums", className))], [value])

export const anomalySidebar = (h: H, input: SidebarInput): Html => {
	const { incident } = input
	const isOpen = incident.status === "open"
	const isStale = isStaleOpenIncident(incident, input.nowMs)
	const tone = severityToneFor(incident)
	const dev = deviation(incident)
	const triageChip = TRIAGE_STATUS_CHIP[incident.triageStatus]
	const fmt = (value: number) => formatSignalValue(incident.signalType, value)
	const live = isOpen && !isStale
	const time = (value: string, className?: string) =>
		relativeTime(h, { value, nowMs: input.nowMs, timeZone: input.timeZone, tooltip: "title", className })
	return h.div(
		[h.Class("flex flex-col")],
		[
			detailRailGroup(h, "Actions", [
				...(isOpen
					? [
							button(
								h,
								{
									size: "sm",
									variant: "outline",
									className: "w-full",
									isDisabled: input.isBusy,
									attributes: [h.OnClick(Message.ClickedResolve())],
								},
								["Resolve anomaly"],
							),
						]
					: []),
				incident.errorIssueId === null
					? button(
							h,
							{
								size: "sm",
								variant: "outline",
								className: "w-full",
								isDisabled: input.isBusy,
								attributes: [h.OnClick(Message.ClickedLinkIssue())],
							},
							[icon(h, "LinkIcon"), "Link issue"],
						)
					: button(
							h,
							{
								size: "sm",
								variant: "outline",
								className: "w-full",
								isDisabled: input.isBusy,
								attributes: [h.OnClick(Message.ClickedUnlink())],
							},
							["Unlink ", shortIssueId(incident.errorIssueId)],
						),
			]),
			detailRailGroup(h, "Details", [
				row(h, "State", [
					h.span(
						[h.Class("text-right text-sm text-foreground")],
						isStale
							? [
									"stale · ",
									relativeTime(h, {
										value: incident.lastTriggeredAt,
										nowMs: input.nowMs,
										timeZone: input.timeZone,
										prefix: "last seen",
									}),
								]
							: [isOpen ? "open" : "resolved"],
					),
				]),
				row(h, "Signal", [
					h.span([h.Class("text-sm text-foreground")], [SIGNAL_LABEL[incident.signalType]]),
				]),
				row(h, "Severity", [
					h.span(
						[h.Class(cn("text-sm font-medium", live ? tone.text : "text-muted-foreground"))],
						[incident.severity],
					),
				]),
				row(
					h,
					"Service",
					[
						h.span(
							[h.Class("flex min-w-0 items-center gap-2")],
							[
								serviceDot(h, { serviceName: incident.serviceName, size: "sm" }),
								h.span([h.Class("truncate text-sm text-foreground")], [incident.serviceName]),
							],
						),
					],
					incident.serviceName,
				),
				row(h, "Environment", [
					h.span([h.Class("text-sm text-foreground")], [incident.deploymentEnv || EMPTY_VALUE]),
				]),
				row(
					h,
					"Detector",
					[
						h.code(
							[h.Class("block max-w-full truncate font-mono text-xs text-muted-foreground")],
							[incident.detectorKey],
						),
					],
					incident.detectorKey,
				),
				...(incident.fingerprintHash === null
					? []
					: [
							row(
								h,
								"Fingerprint",
								[
									h.code(
										[
											h.Class(
												"block max-w-full truncate font-mono text-xs text-muted-foreground",
											),
										],
										[incident.fingerprintHash],
									),
								],
								incident.fingerprintHash,
							),
						]),
			]),
			detailRailGroup(h, "Values", [
				row(h, "Observed", [
					mono(h, fmt(incident.lastObservedValue), live ? tone.text : "text-foreground"),
				]),
				row(h, "At open", [mono(h, fmt(incident.openedValue), "text-muted-foreground")]),
				row(h, "Baseline", [mono(h, fmt(incident.baselineMedian), "text-muted-foreground")]),
				row(h, "Threshold", [mono(h, fmt(incident.thresholdValue), "text-muted-foreground")]),
				row(h, "Deviation", [mono(h, dev.label, live ? tone.text : "text-foreground")]),
				row(h, "Samples", [mono(h, formatNumber(incident.lastSampleCount), "text-muted-foreground")]),
			]),
			...(incident.fingerprints.length > 1
				? [
						detailRailGroup(
							h,
							`Grouped errors · ${incident.fingerprints.length}`,
							incident.fingerprints.map((fingerprint) =>
								h.div(
									[
										h.Key(fingerprint.fingerprintHash),
										h.Class(
											"grid min-h-7 grid-cols-[1fr_auto] items-center gap-x-2 py-0.5",
										),
										h.Title(fingerprint.fingerprintHash),
									],
									[
										h.span(
											[h.Class("flex min-w-0 items-center gap-1.5")],
											[
												statusDot(h, {
													tone:
														fingerprint.resolvedAt !== null
															? "neutral"
															: fingerprint.severity === "critical"
																? "crit"
																: "warn",
												}),
												fingerprint.errorIssueId !== null
													? h.a(
															[
																h.Href(hrefOf(AppRoute.ErrorIssue({ issueId: fingerprint.errorIssueId, search: {} }))),
																h.Class("truncate font-mono text-xs text-muted-foreground hover:text-foreground active:text-foreground"),
															],
															[shortIssueId(fingerprint.errorIssueId)],
														)
													: truncatedId(h, {
															value: fingerprint.fingerprintHash,
															length: 10,
															className:
																"truncate text-xs text-muted-foreground",
														}),
											],
										),
										h.span(
											[h.Class("font-mono text-xs tabular-nums text-muted-foreground")],
											[
												fingerprint.resolvedAt !== null
													? "resolved"
													: fmt(fingerprint.lastValue),
											],
										),
									],
								),
							),
						),
					]
				: []),
			detailRailGroup(h, "Timing", [
				row(h, "First triggered", [
					time(incident.firstTriggeredAt, "text-right text-sm tabular-nums text-foreground"),
				]),
				...(incident.reopenCount > 0 && incident.lastReopenedAt !== null
					? [
							row(h, "Reopened", [
								h.span(
									[h.Class("text-right text-sm tabular-nums text-muted-foreground")],
									[
										time(incident.lastReopenedAt),
										...(incident.reopenCount > 1 ? [` (×${incident.reopenCount})`] : []),
									],
								),
							]),
						]
					: []),
				row(h, "Last triggered", [
					time(incident.lastTriggeredAt, "text-right text-sm tabular-nums text-foreground"),
				]),
				...(incident.resolvedAt === null
					? []
					: [
							row(h, "Resolved", [
								time(
									incident.resolvedAt,
									"text-right text-sm tabular-nums text-muted-foreground",
								),
							]),
						]),
				...(incident.resolveReason === null
					? []
					: [
							row(h, "Reason", [
								h.span(
									[h.Class("text-right text-sm text-muted-foreground")],
									[RESOLVE_REASON_LABEL[incident.resolveReason]],
								),
							]),
						]),
			]),
			detailRailGroup(h, "Triage", [
				triageChip === null
					? h.p(
							[h.Class("text-xs text-muted-foreground")],
							["No AI triage has run for this incident."],
						)
					: badge(
							h,
							{
								pill: true,
								size: "sm",
								className: cn(META_CHIP_CLASS, "w-fit font-medium", triageChip.tone),
							},
							[triageChip.label],
						),
			]),
		],
	)
}
