import type { SecurityAuditEvent, SecurityAuditRunDetail, SecurityAuditUnit } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { textLink } from "../../../ui/text-link"
import { filterChip } from "../../../ui/filter-chip"
import { errorState } from "../../../ui/error-state"
import { panel, panelHeader } from "../../../ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { formatClock, formatUsd, gateOf, isLive, isoOf } from "../kit/format"
import { gateState, placeholderRows } from "../kit/parts"
import {
	countOf,
	filteredUnits,
	gapCount,
	gapUnits,
	UNIT_FILTERS,
	UNIT_LABEL,
	UNIT_TONE,
	filteredEvents,
} from "./derive"
import { type EventFilter, eventLineOf, unitContext, unitName } from "../kit/outcome"
import { EVENTS_PAGE } from "./command"
import { Message, type Model, type UnitFilter } from "./model"
import { emptyMessage } from "../../../ui/empty"

// The run's coverage ledger, its gaps and the event log.

type H = HtmlBuilder<Message>

const unitBadge = (h: H, status: SecurityAuditUnit["status"]): Html => {
	const tone = UNIT_TONE[status]
	return badge(h, { variant: tone === "neutral" ? "muted" : tone }, [UNIT_LABEL[status]])
}

const resultText = (unit: SecurityAuditUnit): string => {
	if (unit.unresolved[0] !== undefined) return unit.unresolved[0]
	if (unit.status === "candidate" || unit.resultFingerprints.length > 0)
		return `${unit.resultFingerprints.length} ${unit.resultFingerprints.length === 1 ? "candidate" : "candidates"}`
	if (unit.status === "in_progress") return unit.agentId === null ? "assigned" : "agent running"
	if (unit.status === "covered") return "nothing reported"
	return ""
}

const unitRow = (h: H, unit: SecurityAuditUnit): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.span(
						[
							h.Class("flex min-w-0 flex-col"),
							h.Title(
								[unit.coverageId, unit.surface, unit.boundary, unit.agentId]
									.filter((part) => part !== null)
									.join("\n"),
							),
						],
						[
							h.span(
								[h.Class(cn("truncate text-sm", unit.stale && "font-mono text-xs"))],
								[unitName(unit)],
							),
							...(unit.stale || unitContext(unit) === ""
								? []
								: [
										h.span(
											[h.Class("truncate text-xs text-muted-foreground")],
											[unitContext(unit)],
										),
									]),
						],
					),
				],
				"w-full max-w-0",
			),
			tableCell(h, [unitBadge(h, unit.status)]),
			tableCell(h, [unit.wave > 0 ? String(unit.wave) : ""], "text-right font-mono tabular-nums"),
			tableCell(
				h,
				[h.span([h.Class("block max-w-40 truncate"), h.Title(resultText(unit))], [resultText(unit)])],
				"text-right text-xs text-muted-foreground",
			),
		],
		undefined,
		[h.Key(unit.coverageId)],
	)

const unitsBody = (
	h: H,
	model: Model,
	rows: (units: ReadonlyArray<SecurityAuditUnit>) => ReadonlyArray<SecurityAuditUnit>,
): Html =>
	AsyncData.matchData(model.units.data, {
		onEmpty: () => placeholderRows(h, 6),
		onFailure: (failure) => {
			const gate = gateOf(failure)
			return gate === null
				? errorState(h, {
						failure,
						title: "Couldn't load the coverage ledger",
						variant: "inline",
						onRetry: Message.ClickedRetry(),
					})
				: gateState(h, gate, "m-4")
		},
		onData: (response) => {
			const shown = rows(response.units)
			return shown.length === 0
				? emptyMessage(h, {}, ["No units in this status"])
				: table(h, { variant: "bare", ariaLabel: "Coverage units" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Unit"]),
								tableHead(h, ["Status"]),
								tableHead(h, ["Wave"], "text-right"),
								tableHead(h, ["Results"], "text-right"),
							]),
						]),
						tableBody(
							h,
							shown.map((unit) => unitRow(h, unit)),
						),
					])
		},
	})

const unitChip = (h: H, model: Model, run: SecurityAuditRunDetail, filter: UnitFilter): Html =>
	filterChip(
		h,
		{
			isPressed: model.unitFilter === filter,
			onClick: Message.PickedUnitFilter({ filter }),
			size: "sm",
			hasDot: filter !== "all",
			tone: filter === "all" ? "neutral" : UNIT_TONE[filter],
			count: String(filter === "all" ? run.unitTotal : countOf(run, filter)),
			attributes: [h.Key(filter)],
		},
		[filter === "all" ? "All" : UNIT_LABEL[filter]],
	)

export const ledgerPanel = (h: H, model: Model, run: SecurityAuditRunDetail): Html =>
	panel(h, { className: "min-w-0 overflow-hidden" }, [
		panelHeader(h, {
			title: "Coverage ledger",
			action: h.span([h.Class("text-xs text-muted-foreground")], [`${run.unitTotal} units`]),
		}),
		h.div(
			[h.Class("flex flex-wrap gap-1.5 border-b px-4 py-3")],
			UNIT_FILTERS.filter((filter) => filter === "all" || countOf(run, filter) > 0).map((filter) =>
				unitChip(h, model, run, filter),
			),
		),
		unitsBody(h, model, (units) => filteredUnits(units, model.unitFilter)),
		...(model.isLedgerOpen ? [ledgerToggle(h, "Show only the gaps")] : []),
	])

const ledgerToggle = (h: H, label: string): Html =>
	h.div(
		[h.Class("border-t px-4 py-2.5")],
		[
			textLink(h, { tone: "muted", className: "text-xs underline", onClick: Message.ToggledLedger() }, [
				label,
			]),
		],
	)

/** Every gap status, as `gapCount` adds them up, so the header and the cells agree. */
const GAP_SUMMARY = [
	{ statuses: ["deferred"], label: "deferred, not reached" },
	{ statuses: ["blocked"], label: "blocked, missing context" },
	{ statuses: ["planned", "in_progress"], label: "planned or unfinished, not closed" },
] as const

export const gapsPanel = (h: H, model: Model, run: SecurityAuditRunDetail): Html => {
	return panel(h, { className: "min-w-0 overflow-hidden" }, [
		panelHeader(h, {
			title: "Gaps",
			action: h.span(
				[h.Class("text-xs text-muted-foreground")],
				[`${gapCount(run)} units not covered`],
			),
		}),
		h.div(
			[h.Class("grid grid-cols-3 divide-x border-b")],
			GAP_SUMMARY.map((entry) =>
				h.div(
					[h.Key(entry.label), h.Class("flex flex-col gap-0.5 px-4 py-3")],
					[
						h.span(
							[h.Class("font-mono text-lg tabular-nums")],
							[String(entry.statuses.reduce((sum, status) => sum + countOf(run, status), 0))],
						),
						h.span([h.Class("text-xs text-muted-foreground")], [entry.label]),
					],
				),
			),
		),
		unitsBody(h, model, (units) => gapUnits(units).slice(0, 5)),
		ledgerToggle(h, `Show all ${gapCount(run)} gaps and the full ledger`),
	])
}

const eventRow = (h: H, event: SecurityAuditEvent, timeZone: string): Html => {
	const line = eventLineOf(event)
	return h.li(
		[h.Key(event.id), h.Class("grid grid-cols-[4.5rem_1fr_auto] gap-3 px-4 py-3 text-xs")],
		[
			h.time(
				[h.Class("font-mono tabular-nums text-muted-foreground"), h.Title(isoOf(event.at))],
				[formatClock(event.at, timeZone)],
			),
			h.span(
				[h.Class("flex min-w-0 flex-col gap-0.5")],
				[
					h.span(
						[h.Class(cn("text-sm break-words", line.isProblem && "text-severity-warn"))],
						[line.sentence],
					),
					...(line.meta === null || line.meta === ""
						? []
						: [h.span([h.Class("font-mono text-muted-foreground")], [line.meta])]),
				],
			),
			h.span(
				[h.Class("font-mono tabular-nums text-muted-foreground")],
				[event.costUsd === null ? "" : formatUsd(event.costUsd)],
			),
		],
	)
}

const EVENT_FILTER_LABEL = {
	all: "All",
	problems: "Problems",
	leads: "Leads",
} satisfies Record<EventFilter, string>

const EVENT_FILTERS: ReadonlyArray<EventFilter> = ["all", "problems", "leads"]

const eventChips = (h: H, model: Model, events: ReadonlyArray<SecurityAuditEvent>): Html =>
	h.div(
		[h.Class("flex flex-wrap gap-1.5 border-b px-4 py-3")],
		EVENT_FILTERS.map((filter) =>
			filterChip(
				h,
				{
					isPressed: model.eventFilter === filter,
					onClick: Message.PickedEventFilter({ filter }),
					size: "sm",
					hasDot: filter !== "all",
					tone: filter === "problems" ? "warn" : filter === "leads" ? "done" : "neutral",
					count: String(filteredEvents(events, filter).length),
					attributes: [h.Key(filter)],
				},
				[EVENT_FILTER_LABEL[filter]],
			),
		),
	)

export const eventsPanel = (
	h: H,
	model: Model,
	events: ReadonlyArray<SecurityAuditEvent>,
	run: SecurityAuditRunDetail,
	timeZone: string,
): Html =>
	panel(h, { className: "min-w-0 overflow-hidden" }, [
		panelHeader(h, {
			title: "Events",
			action: h.span(
				[h.Class("text-xs text-muted-foreground")],
				[isLive(run) ? "Newest first · refreshes every 5 s" : "Newest first"],
			),
		}),
		AsyncData.matchData(model.events.data, {
			onEmpty: () => placeholderRows(h, 6),
			onFailure: (failure) => {
				const gate = gateOf(failure)
				return gate === null
					? errorState(h, {
							failure,
							title: "Couldn't load events",
							variant: "inline",
							onRetry: Message.ClickedRetry(),
						})
					: gateState(h, gate, "m-4")
			},
			onData: () => {
				const shown = filteredEvents(events, model.eventFilter)
				return h.div(
					[],
					[
						...(events.length === 0 ? [] : [eventChips(h, model, events)]),
						shown.length === 0
							? emptyMessage(h, {}, [
									events.length === 0
										? "No events yet"
										: model.eventFilter === "problems"
											? "No problems in the events read so far"
											: "No events about leads read so far",
								])
							: h.ol(
									[h.Class("divide-y")],
									shown.map((event) => eventRow(h, event, timeZone)),
								),
					],
				)
			},
		}),
		...(AsyncData.hasData(model.events.data) && model.hasMoreOlder && events.length >= EVENTS_PAGE
			? [
					h.div(
						[h.Class("border-t px-4 py-2.5")],
						[
							textLink(
								h,
								{
									tone: "muted",
									className: "text-xs underline",
									onClick: Message.ClickedLoadOlder(),
									isDisabled: model.isLoadingOlder,
								},
								[model.isLoadingOlder ? "Loading older events…" : "Load older events"],
							),
						],
					),
				]
			: []),
	])
