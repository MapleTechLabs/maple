import type { AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	computeIncidentStats,
	formatAlertDateTimeFull,
	formatAlertDuration,
	formatSignalValue,
} from "@maple/web-data/alerts/form-utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "../../../ui/button"
import { card, cardPanel } from "../../../ui/card"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import * as Menu from "../../../ui/menu"
import { meter } from "../../../ui/meter"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import { segmentedSelect } from "../../../ui/segmented-select"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { docsLink, emptyActions } from "../../kit/signal-empty-state"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { alertStatusBadge } from "../shared/badges"
import { msIso } from "../shared/time"
import { Message } from "./message"
import type { Model, StateFilter } from "./model"
import { incidentMenuId } from "./update"
import { sectionHeading } from "../../kit/section-heading"

// The rule detail's History tab.

type H = HtmlBuilder<Message>

const INCIDENT_RENDER_LIMIT = 100

export const historyTab = (
	h: H,
	model: Model,
	rule: AlertRuleDocument,
	ruleIncidents: ReadonlyArray<AlertIncidentDocument>,
	timeZone: string,
	nowMs: number,
): Html => {
	const stats = computeIncidentStats([...ruleIncidents])
	const maxContributorCount = stats.topContributors[0]?.[1] ?? 1
	const filtered =
		model.stateFilter === "all"
			? ruleIncidents
			: ruleIncidents.filter((i) => i.status === model.stateFilter)
	const visible = model.isShowingAllIncidents ? filtered : filtered.slice(0, INCIDENT_RENDER_LIMIT)
	const filterOptions: ReadonlyArray<{ value: StateFilter; label: string }> = [
		{ value: "all", label: "All" },
		{ value: "open", label: "Fired" },
		{ value: "resolved", label: "Resolved" },
	]
	return h.div(
		[h.Class("space-y-6")],
		[
			h.div(
				[h.Class("flex items-center justify-between")],
				[
					h.div(
						[],
						[
							sectionHeading(h, { title: "History" }),
							h.p(
								[h.Class("text-muted-foreground text-sm")],
								[String(stats.totalTriggered), " total triggers"],
							),
						],
					),
					segmentedSelect(h, {
						options: filterOptions,
						value: model.stateFilter,
						onChange: (filter) => Message.ClickedStateFilter({ filter }),
						size: "sm",
						ariaLabel: "Filter incidents",
					}),
				],
			),
			statRail(h, { columns: 2 }, [
				statRailItem(h, {
					size: "sm",
					eyebrow: "Total triggered",
					value: String(stats.totalTriggered),
				}),
				statRailItem(h, { size: "sm", eyebrow: "Avg resolution", value: stats.avgResolution }),
			]),
			...(stats.topContributors.length > 0
				? [
						h.div(
							[h.Class("space-y-2")],
							[
								h.h3([h.Class("text-sm font-semibold")], ["Top contributors"]),
								card(h, [
									cardPanel(
										h,
										stats.topContributors.map(([groupKey, count]) =>
											h.div(
												[h.Key(groupKey), h.Class("flex items-center gap-2")],
												[
													badge(
														h,
														{
															variant: "outline",
															className:
																"min-w-0 max-w-[160px] shrink justify-start text-xs",
															attributes: [h.Title(groupKey)],
														},
														[h.span([h.Class("truncate")], [groupKey])],
													),
													meter(h, {
														value: count,
														max: maxContributorCount,
														className: "h-2 flex-1 bg-muted",
														fillClassName:
															count === maxContributorCount
																? "bg-severity-error"
																: "bg-severity-warn",
													}),
													h.span(
														[
															h.Class(
																"text-xs text-muted-foreground tabular-nums shrink-0",
															),
														],
														[String(count), "/", String(stats.totalTriggered)],
													),
												],
											),
										),
										"space-y-2 p-5",
									),
								]),
							],
						),
					]
				: []),
			filtered.length === 0
				? empty(
						h,
						[
							emptyHeader(h, [
								emptyMedia(h, { variant: "icon" }, [icon(h, "CheckIcon", { size: 18 })]),
								emptyTitle(h, ["No incidents"]),
								emptyDescription(h, [
									model.stateFilter === "all"
										? "This rule has not fired. It opens an incident when the threshold is crossed."
										: `This rule has no ${model.stateFilter} incidents.`,
								]),
							]),
							emptyActions(h, [
								...(model.stateFilter !== "all"
									? [
											button(
												h,
												{
													variant: "outline",
													size: "sm",
													attributes: [
														h.OnClick(
															Message.ClickedStateFilter({ filter: "all" }),
														),
													],
												},
												["Show all incidents"],
											),
										]
									: []),
								docsLink(h, "incidents"),
							]),
						],
						"py-12",
					)
				: table(h, {}, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["State"], "w-24"),
								tableHead(h, ["Group"], "w-44"),
								tableHead(h, ["Labels"]),
								tableHead(h, ["Triggered at"], "w-44"),
								tableHead(h, ["Duration"], "w-28"),
								tableHead(h, ["Issue"], "w-16"),
								tableHead(h, [], "w-[50px]"),
							]),
						]),
						tableBody(
							h,
							visible.map((incident) => incidentRow(h, model, rule, incident, timeZone, nowMs)),
						),
					]),
			...(visible.length < filtered.length
				? [
						h.div(
							[h.Class("flex justify-center pt-3")],
							[
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										attributes: [h.OnClick(Message.ClickedShowAllIncidents())],
									},
									[`Show all ${filtered.length.toLocaleString("en-US")}`],
								),
							],
						),
					]
				: []),
		],
	)
}

const incidentRow = (
	h: H,
	model: Model,
	rule: AlertRuleDocument,
	incident: AlertIncidentDocument,
	timeZone: string,
	nowMs: number,
): Html => {
	const isOpen = incident.status === "open"
	const menuId = incidentMenuId(incident.id)
	return tableRow(h, [
		tableCell(h, [
			alertStatusBadge(h, isOpen ? (incident.holdReason != null ? "held" : "firing") : "resolved"),
		]),
		tableCell(h, [
			h.span(
				[
					h.Class("block max-w-[180px] truncate font-mono text-muted-foreground"),
					h.Title(incident.groupKey ?? "all"),
				],
				[incident.groupKey ?? "all"],
			),
		]),
		tableCell(h, [
			h.div(
				[h.Class("flex flex-wrap gap-1")],
				[
					badge(h, { variant: "secondary", className: "text-xs font-mono" }, [
						rule.signalType.replace("_", " "),
						":",
						" ",
						formatSignalValue(rule.signalType, incident.lastObservedValue),
					]),
					badge(h, { variant: "secondary", className: "text-xs font-mono" }, [
						"threshold:",
						" ",
						formatSignalValue(rule.signalType, incident.threshold),
					]),
				],
			),
		]),
		tableCell(h, [formatAlertDateTimeFull(incident.firstTriggeredAt, timeZone)], "text-xs"),
		tableCell(h, [
			h.span(
				[h.Class(cn("text-xs tabular-nums", isOpen && "text-severity-error font-medium"))],
				[formatAlertDuration(incident.firstTriggeredAt, incident.resolvedAt ?? msIso(nowMs))],
			),
		]),
		tableCell(h, [
			incident.errorIssueId != null
				? h.a(
						[
							h.Href(
								hrefOf(AppRoute.ErrorIssue({ issueId: incident.errorIssueId, search: {} })),
							),
							h.Class(
								"text-xs text-primary underline-offset-4 hover:underline active:underline",
							),
						],
						["View"],
					)
				: h.span([h.Class("text-xs text-foreground-subtle")], [EMPTY_VALUE]),
		]),
		tableCell(h, [
			h.div(
				[h.Class("flex items-center justify-end gap-1")],
				[
					rowActionsMenu(h, {
						slotId: menuId,
						model: model.menus[menuId] ?? Menu.init(menuId),
						entries: [
							{
								_tag: "Item",
								value: "investigate",
								label: "Open investigation",
								icon: "ChatBubbleSparkleIcon",
							},
							{ _tag: "Item", value: "all", label: "View all incidents" },
						],
						label: "Incident actions",
						toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, message }),
					}),
				],
			),
		]),
	])
}
