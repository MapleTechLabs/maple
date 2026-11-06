import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { SEVERITY_TONE } from "@maple/web-data/anomalies/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "@maple/views/ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyTitle } from "@maple/views/ui/empty"
import { excludedEmptyHint } from "@maple/views/ui/filters/excluded-empty-hint"
import { icon } from "@maple/views/ui/icon"
import { listFooter } from "@maple/views/ui/list-footer"
import { pressable } from "@maple/views/ui/pressable"
import { statusDot } from "@maple/views/ui/status-dot"
import { serviceDot } from "@maple/views/ui/values"
import { docsLink, signalEmptyState } from "../../kit/signal-empty-state"
import { emptyActions, filteredEmpty, presenceLoading } from "@maple/views/ui/signal-empty-state"
import { presenceOf } from "@maple/views/data/signal-presence"
import { anomalyRow } from "../kit/row"
import { clusterByService, GROUP_LABEL, groupIncidents } from "./derive"
import { Message } from "./message"
import type { GroupKey, Model, StatusTab } from "./model"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"

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
			pressable(
				h,
				{
					onClick: Message.ToggledGroup({ group: key }),
					className: cn(
						"sticky top-0 z-10 flex h-8 w-full items-center gap-2 border-b border-border-subtle bg-surface-sunken pr-2 pl-2 text-left outline-none",
						"backdrop-blur supports-[backdrop-filter]:bg-surface-strong",
						"hover:bg-surface-strong active:bg-surface-strong",
					),
					attributes: [h.AriaExpanded(isOpen), h.AriaControls(`anomaly-group-${key}`)],
				},
				[
					h.span(
						[h.Class("flex size-4 shrink-0 items-center justify-center text-muted-foreground")],
						[icon(h, isOpen ? "ChevronDownIcon" : "ChevronRightIcon", { size: 14 })],
					),
					statusDot(h, { tone: SEVERITY_TONE[key].tone, size: "lg" }),
					h.span([h.Class("shrink-0 text-sm font-medium text-foreground")], [GROUP_LABEL[key]]),
					typography(h, { size: "xs", tone: "muted", numeric: true }, [String(incidents.length)]),
				],
			),
			...(isOpen
				? [
						h.div(
							[
								h.Id(`anomaly-group-${key}`),
								h.Role("list"),
								h.Class("divide-y divide-border-subtle"),
							],
							Arr.map(clusterByService(incidents), (cluster) =>
								h.div(
									[h.Key(cluster.key + (cluster.incidents[0]?.id ?? ""))],
									[
										...(cluster.incidents.length >= 2
											? [
													h.div(
														[
															h.Class(
																"flex h-7 items-center gap-1.5 border-b border-border-subtle bg-surface-faint pl-5 text-2xs text-muted-foreground",
															),
														],
														[
															serviceDot(h, {
																serviceName: cluster.serviceName,
																size: "sm",
															}),
															h.span(
																[h.Class("font-medium text-foreground-soft")],
																[cluster.serviceName],
															),
															...(cluster.deploymentEnv
																? [h.span([], [cluster.deploymentEnv])]
																: []),
															h.span(
																[h.Class("tabular-nums")],
																[
																	String(cluster.incidents.length),
																	" anomalies",
																],
															),
														],
													),
												]
											: []),
										h.div(
											[h.Class("divide-y divide-border-subtle")],
											Arr.map(cluster.incidents, (incident) =>
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

const quietEmpty = (
	h: H,
	model: Model,
	status: StatusTab,
	excludedHint: Html | null,
	timeZone: string,
): Html => {
	const presence = presenceOf(model.presence, "traces")
	if (presence.status === "loading") return h.div([h.Class("p-4")], [presenceLoading(h)])
	if (presence.status === "absent")
		return h.div(
			[h.Class("p-4")],
			[
				signalEmptyState(h, {
					signal: "traces",
					presence,
					nowMs: model.nowMs,
					timeZone,
					noun: "anomalies",
					purpose: PURPOSE,
					detail: excludedHint,
				}),
			],
		)
	return h.div(
		[h.Class("p-4")],
		[
			empty(h, [
				emptyHeader(h, [
					emptyTitle(h, [status === "open" ? "No open anomalies" : "No anomalies"]),
					emptyDescription(h, [PURPOSE]),
				]),
				...(presence.status === "present"
					? [
							emptyContent(h, [
								emptyActions(h, [
									linkButton(
										h,
										{
											variant: "outline",
											size: "sm",
											href: hrefOf(AppRoute.AlertsCreate({ search: {} })),
										},
										["Create an alert rule"],
									),
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
	if (input.incidents.length === 0) return quietEmpty(h, model, input.status, excludedHint, input.timeZone)
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
			...Arr.map(groupIncidents(input.incidents), ([key, incidents]) =>
				group(h, model, key, incidents, input.timeZone),
			),
			...(footer === null ? [] : [footer]),
		],
	)
}
