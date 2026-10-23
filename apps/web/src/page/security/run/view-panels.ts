import type {
	SecurityAuditEvent,
	SecurityAuditFinding,
	SecurityAuditRunDetail,
	SecurityAuditUnit,
} from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { panel, panelHeader } from "../../../ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import {
	formatClock,
	formatUsd,
	gateOf,
	isLive,
	isoOf,
	locationOf,
	SECURITY_SEVERITY_LABEL,
} from "../kit/format"
import { gateState, placeholderRows } from "../kit/parts"
import { SEVERITY_TONE } from "../../errors/kit/severity"
import {
	countOf,
	filteredUnits,
	gapCount,
	gapUnits,
	UNIT_FILTERS,
	UNIT_LABEL,
	UNIT_TONE,
	unitPath,
	unitTitle,
	unitsOf,
} from "./derive"
import { Message, type Model, type UnitFilter } from "./model"

// The run's coverage ledger, its gaps, what it reported, and the event log.

type H = HtmlBuilder<Message>

const unitBadge = (h: H, status: SecurityAuditUnit["status"]): Html => {
	const tone = UNIT_TONE[status]
	return badge(h, { variant: tone === "neutral" ? "muted" : tone }, [UNIT_LABEL[status]])
}

const resultText = (unit: SecurityAuditUnit): string => {
	if (unit.unresolved[0] !== undefined) return unit.unresolved[0]
	if (unit.status === "candidate" || unit.resultFingerprints.length > 0)
		return `${unit.resultFingerprints.length} ${unit.resultFingerprints.length === 1 ? "candidate" : "candidates"}`
	if (unit.status === "in_progress") return unit.agentId ?? "assigned"
	if (unit.status === "covered") return "no issues"
	return ""
}

const unitRow = (h: H, unit: SecurityAuditUnit): Html =>
	tableRow(
		h,
		[
			tableCell(h, [
				h.span(
					[h.Class("flex min-w-0 flex-col"), h.Title(unit.coverageId)],
					[
						h.span(
							[h.Class(cn("truncate text-sm", unit.stale && "font-mono text-xs"))],
							[unitTitle(unit)],
						),
						...(unit.stale || unitPath(unit) === ""
							? []
							: [
									h.span(
										[h.Class("truncate text-xs text-muted-foreground")],
										[unitPath(unit)],
									),
								]),
					],
				),
			]),
			tableCell(h, [unitBadge(h, unit.status)]),
			tableCell(h, [unit.wave > 0 ? String(unit.wave) : ""], "text-right font-mono tabular-nums"),
			tableCell(
				h,
				[h.span([h.Class("block max-w-56 truncate"), h.Title(resultText(unit))], [resultText(unit)])],
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
						title: "Failed to load the coverage ledger",
						variant: "inline",
						onRetry: Message.ClickedRetry(),
					})
				: gateState(h, gate, "m-4")
		},
		onData: (response) => {
			const shown = rows(response.units)
			return shown.length === 0
				? h.p([h.Class("px-4 py-6 text-sm text-muted-foreground")], ["No units in this status."])
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

const filterChip = (h: H, model: Model, run: SecurityAuditRunDetail, filter: UnitFilter): Html => {
	const count = filter === "all" ? run.unitTotal : countOf(run, filter)
	const isActive = model.unitFilter === filter
	return h.button(
		[
			h.Key(filter),
			h.Type("button"),
			h.AriaPressed(String(isActive)),
			h.OnClick(Message.PickedUnitFilter({ filter })),
			h.Class(
				cn(
					"inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
					isActive
						? "border-foreground/30 bg-muted text-foreground"
						: "text-muted-foreground hover:text-foreground",
				),
			),
		],
		[
			filter === "all" ? "All" : UNIT_LABEL[filter],
			h.span([h.Class("font-mono tabular-nums text-muted-foreground")], [String(count)]),
		],
	)
}

export const ledgerPanel = (h: H, model: Model, run: SecurityAuditRunDetail): Html =>
	panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Coverage ledger",
			action: h.span([h.Class("text-xs text-muted-foreground")], [`${run.unitTotal} units`]),
		}),
		h.div(
			[h.Class("flex flex-wrap gap-1.5 border-b px-4 py-3")],
			UNIT_FILTERS.filter((filter) => filter === "all" || countOf(run, filter) > 0).map((filter) =>
				filterChip(h, model, run, filter),
			),
		),
		unitsBody(h, model, (units) => filteredUnits(units, model.unitFilter)),
	])

const GAP_SUMMARY = [
	{ status: "deferred", label: "deferred, budget reached" },
	{ status: "blocked", label: "blocked, missing context" },
	{ status: "planned", label: "planned, never assigned" },
] as const

export const gapsPanel = (h: H, model: Model, run: SecurityAuditRunDetail): Html => {
	const gaps = gapUnits(unitsOf(model))
	return panel(h, { className: "overflow-hidden" }, [
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
					[h.Key(entry.status), h.Class("flex flex-col gap-0.5 px-4 py-3")],
					[
						h.span(
							[h.Class("font-mono text-lg tabular-nums")],
							[String(countOf(run, entry.status))],
						),
						h.span([h.Class("text-xs text-muted-foreground")], [entry.label]),
					],
				),
			),
		),
		model.isLedgerOpen
			? unitsBody(h, model, (units) => filteredUnits(units, model.unitFilter))
			: unitsBody(h, model, () => gaps.slice(0, 5)),
		h.div(
			[h.Class("border-t px-4 py-2.5")],
			[
				h.button(
					[
						h.Type("button"),
						h.Class(
							"text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground",
						),
						h.OnClick(Message.ToggledLedger()),
					],
					[
						model.isLedgerOpen
							? "Show only the gaps"
							: `Show all ${gaps.length} gaps and the full ledger`,
					],
				),
			],
		),
	])
}

const resultMark = (h: H, finding: SecurityAuditFinding): Html =>
	finding.verdict === "needs_validation"
		? badge(h, { variant: "outline", className: "border-dashed" }, ["Needs validation"])
		: finding.verdict === "rejected"
			? badge(h, { variant: "muted", className: "line-through" }, ["Rejected"])
			: finding.overallSeverity === null || finding.overallSeverity === "informational"
				? badge(h, { variant: "muted" }, ["Info"])
				: badge(h, { variant: "outline", className: SEVERITY_TONE[finding.overallSeverity] }, [
						SECURITY_SEVERITY_LABEL[finding.overallSeverity],
					])

export const resultsPanel = (
	h: H,
	model: Model,
	results: ReadonlyArray<SecurityAuditFinding>,
	run: SecurityAuditRunDetail,
): Html =>
	panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Results of this run",
			action: h.span(
				[h.Class("text-xs text-muted-foreground")],
				[`${results.length} ${results.length === 1 ? "record" : "records"}`],
			),
		}),
		AsyncData.matchData(model.findings.data, {
			onEmpty: () => placeholderRows(h, 4),
			onFailure: (failure) => {
				const gate = gateOf(failure)
				return gate === null
					? errorState(h, {
							failure,
							title: "Failed to load findings",
							variant: "inline",
							onRetry: Message.ClickedRetry(),
						})
					: gateState(h, gate, "m-4")
			},
			onData: () =>
				results.length === 0
					? h.p(
							[h.Class("px-4 py-6 text-sm text-muted-foreground")],
							[isLive(run) ? "Nothing reported yet." : "This run reported no findings."],
						)
					: h.ul(
							[h.Class("divide-y")],
							results.map((finding) =>
								h.li(
									[h.Key(finding.fingerprint)],
									[
										h.a(
											[
												h.Href(
													hrefOf(
														AppRoute.SecurityFinding({
															targetId: finding.targetId,
															fingerprint: finding.fingerprint,
														}),
													),
												),
												h.Class(
													"flex items-center gap-4 px-4 py-3 hover:bg-muted/40",
												),
											],
											[
												h.span(
													[h.Class("flex min-w-0 flex-1 flex-col")],
													[
														h.span(
															[h.Class("truncate text-sm")],
															[finding.record.title],
														),
														h.span(
															[
																h.Class(
																	"truncate font-mono text-xs text-muted-foreground",
																),
															],
															[locationOf(finding.record) ?? ""],
														),
													],
												),
												resultMark(h, finding),
											],
										),
									],
								),
							),
						),
		}),
		...(run.reports === null
			? []
			: [
					h.div(
						[h.Class("flex flex-wrap items-center gap-3 border-t px-4 py-2.5 text-xs")],
						[
							h.span([h.Class("text-muted-foreground")], ["Reports:"]),
							...(
								[
									["report", "REPORT.md"],
									["findingsDetail", "FINDINGS-DETAIL.md"],
									["needsValidation", "NEEDS-VALIDATION.md"],
								] as const
							).map(([report, label]) =>
								h.button(
									[
										h.Key(report),
										h.Type("button"),
										h.Class(
											"font-mono underline underline-offset-2 hover:text-foreground",
										),
										h.OnClick(Message.ClickedReport({ report })),
									],
									[label],
								),
							),
						],
					),
				]),
	])

const eventRow = (h: H, event: SecurityAuditEvent, timeZone: string): Html => {
	const text = event.message ?? event.detail ?? (event.phase === null ? "" : `Phase ${event.phase}`)
	const meta = [
		event.kind === "Agent"
			? [event.role, event.agentId].filter((part) => part !== null).join(" ")
			: event.phase,
		event.outcome,
	]
		.filter((part) => part !== null && part !== "" && part !== "ok")
		.join(" · ")
	return h.li(
		[h.Key(event.id), h.Class("grid grid-cols-[4.5rem_3.5rem_1fr_auto] gap-3 px-4 py-3 text-xs")],
		[
			h.time(
				[h.Class("font-mono tabular-nums text-muted-foreground"), h.Title(isoOf(event.at))],
				[formatClock(event.at, timeZone)],
			),
			h.span([h.Class("uppercase tracking-wide text-muted-foreground")], [event.kind]),
			h.span(
				[h.Class("flex min-w-0 flex-col gap-0.5")],
				[
					h.span([h.Class("text-sm break-words")], [text]),
					...(meta === "" ? [] : [h.span([h.Class("text-muted-foreground")], [meta])]),
				],
			),
			h.span(
				[h.Class("font-mono tabular-nums text-muted-foreground")],
				[event.costUsd === null ? "" : formatUsd(event.costUsd)],
			),
		],
	)
}

export const eventsPanel = (
	h: H,
	model: Model,
	events: ReadonlyArray<SecurityAuditEvent>,
	run: SecurityAuditRunDetail,
	timeZone: string,
): Html =>
	panel(h, { className: "overflow-hidden" }, [
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
							title: "Failed to load events",
							variant: "inline",
							onRetry: Message.ClickedRetry(),
						})
					: gateState(h, gate, "m-4")
			},
			onData: () =>
				events.length === 0
					? h.p([h.Class("px-4 py-6 text-sm text-muted-foreground")], ["No events yet."])
					: h.ol(
							[h.Class("divide-y")],
							events.map((event) => eventRow(h, event, timeZone)),
						),
		}),
		...(AsyncData.hasData(model.events.data) && model.hasMoreOlder && events.length >= 200
			? [
					h.div(
						[h.Class("border-t px-4 py-2.5")],
						[
							h.button(
								[
									h.Type("button"),
									h.Disabled(model.isLoadingOlder),
									h.Class(
										"text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground",
									),
									h.OnClick(Message.ClickedLoadOlder()),
								],
								[model.isLoadingOlder ? "Loading older events..." : "Load older events"],
							),
						],
					),
				]
			: []),
	])
