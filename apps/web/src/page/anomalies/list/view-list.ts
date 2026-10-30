import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { SEVERITY_TONE } from "@maple/web-data/anomalies/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "../../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyTitle } from "../../../ui/empty"
import { excludedEmptyHint } from "../../../ui/filters/excluded-empty-hint"
import { icon } from "../../../ui/icon"
import { listFooter } from "../../../ui/list-footer"
import { statusDot } from "../../../ui/status-dot"
import { serviceDot } from "../../../ui/values"
import { docsLink, emptyActions, filteredEmpty, presenceLoading } from "../../kit/signal-empty-state"
import { presenceOf } from "../../kit/signal-presence"
import { anomalyRow } from "../kit/row"
import { clusterByService, GROUP_LABEL, groupIncidents } from "./derive"
import { Message } from "./message"
import type { GroupKey, Model, StatusTab } from "./model"

// `AnomaliesPageBody` and `AnomalyGroup`: the anomalies, grouped.

type H = HtmlBuilder<Message>

const group = (
	h: H,
	model: Model,
	key: GroupKey,
	incidents: ReadonlyArray<AnomalyIncidentDocument>,
	timeZone: string,
): Html => {
	const isOpen = !model.collapsedGroups.includes(key)
	return h.section(
		[h.Key(key)],
		[
			h.button(
				[
					h.Type("button"),
					h.OnClick(Message.ToggledGroup({ group: key })),
					h.AriaExpanded(isOpen),
					h.AriaControls(`anomaly-group-${key}`),
					h.Class(
						cn(
							"sticky top-0 z-10 flex h-8 w-full items-center gap-2 border-b border-border/60 bg-muted/40 pr-2 pl-2 text-left outline-none",
							"backdrop-blur supports-[backdrop-filter]:bg-muted/60",
							"hover:bg-muted/60",
						),
					),
				],
				[
					h.span(
						[h.Class("flex size-4 shrink-0 items-center justify-center text-muted-foreground")],
						[icon(h, isOpen ? "ChevronDownIcon" : "ChevronRightIcon", { size: 14 })],
					),
					statusDot(h, { tone: SEVERITY_TONE[key].tone, size: "lg" }),
					h.span([h.Class("shrink-0 text-sm font-medium text-foreground")], [GROUP_LABEL[key]]),
					h.span([h.Class("text-xs text-muted-foreground tabular-nums")], [String(incidents.length)]),
				],
			),
			...(isOpen
				? [
						h.div(
							[h.Id(`anomaly-group-${key}`), h.Role("list"), h.Class("divide-y divide-border/60")],
							clusterByService(incidents).map((cluster) =>
								h.div(
									[h.Key(cluster.key + (cluster.incidents[0]?.id ?? ""))],
									[
										...(cluster.incidents.length >= 2
											? [
													h.div(
														[
															h.Class(
																"flex h-7 items-center gap-1.5 border-b border-border/60 bg-muted/20 pl-5 text-2xs text-muted-foreground",
															),
														],
														[
															serviceDot(h, { serviceName: cluster.serviceName, size: "sm" }),
															h.span([h.Class("font-medium text-foreground/80")], [cluster.serviceName]),
															...(cluster.deploymentEnv ? [h.span([], [cluster.deploymentEnv])] : []),
															h.span([h.Class("tabular-nums")], [String(cluster.incidents.length), " anomalies"]),
														],
													),
												]
											: []),
										h.div(
											[h.Class("divide-y divide-border/60")],
											cluster.incidents.map((incident) =>
												h.div(
													[h.Key(incident.id), h.Role("listitem")],
													[
														anomalyRow(h, {
															incident,
															nowMs: model.nowMs,
															timeZone,
															isFocused: model.focusedId === incident.id,
															onHover: Message.HoveredRow({ id: incident.id }),
														}),
													],
												),
											),
										),
									],
								),
							),
						),
					]
				: []),
		],
	)
}

const PURPOSE =
	"The detector compares every service's error rate, latency, throughput, error fingerprints, and log volume against its own 7-day baseline. Incidents appear here when something deviates."

const quietEmpty = (h: H, model: Model, status: StatusTab, excludedHint: Html | null): Html => {
	const presence = presenceOf(model.presence, "traces")
	if (presence.status === "loading") return h.div([h.Class("p-4")], [presenceLoading(h)])
	return h.div(
		[h.Class("p-4")],
		[
			empty(h, [
				emptyHeader(h, [
					emptyTitle(h, [status === "open" ? "No open anomalies" : "No anomalies"]),
					emptyDescription(h, [
						PURPOSE,
						...(presence.status === "absent"
							? [" Anomaly detection learns a baseline from your traces and logs. Send telemetry to start."]
							: []),
					]),
				]),
				...(presence.status === "absent"
					? [
							emptyContent(h, [
								emptyActions(h, [
									linkButton(
										h,
										{ size: "sm", className: "gap-2", href: hrefOf(AppRoute.Settings({ search: { tab: "ingestion" } })) },
										[icon(h, "ConnectionIcon"), "Set up tracing"],
									),
									docsLink(h, "instrumentation", "Setup guide"),
								]),
							]),
						]
					: presence.status === "present"
						? [
								emptyContent(h, [
									emptyActions(h, [
										linkButton(h, { variant: "outline", size: "sm", href: hrefOf(AppRoute.AlertsCreate({ search: {} })) }, [
											"Create an alert rule",
										]),
										docsLink(h, "alertRules", "Alert rules"),
									]),
								]),
							]
						: []),
				...(excludedHint === null ? [] : [excludedHint]),
			]),
		],
	)
}

export type BodyInput = Readonly<{
	incidents: ReadonlyArray<AnomalyIncidentDocument>
	status: StatusTab
	hasActiveFilters: boolean
	excludedValues: ReadonlyArray<string>
	hasMore: boolean
	timeZone: string
}>

export const listBody = (h: H, model: Model, input: BodyInput): Html => {
	const excludedHint = excludedEmptyHint(h, {
		excluded: input.excludedValues,
		onClear: Message.ClickedClearExclusions(),
		className: "max-w-lg",
	})
	if (input.incidents.length === 0 && input.hasActiveFilters)
		return h.div(
			[h.Class("p-4")],
			[
				filteredEmpty(h, {
					noun: "anomalies",
					description: "Try widening or clearing the filters.",
					onClear: Message.ClickedClearFilters(),
					detail: excludedHint,
				}),
			],
		)
	if (input.incidents.length === 0) return quietEmpty(h, model, input.status, excludedHint)
	const footer = input.hasMore
		? listFooter(h, {
				hasMore: true,
				isLoading: model.isLoadingMore,
				onLoadMore: Message.ClickedLoadMore(),
				className: "p-4",
			})
		: null
	return h.div(
		[],
		[
			...groupIncidents(input.incidents).map(([key, incidents]) => group(h, model, key, incidents, input.timeZone)),
			...(footer === null ? [] : [footer]),
		],
	)
}
