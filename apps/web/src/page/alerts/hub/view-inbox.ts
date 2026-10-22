import type { AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { countLabel, EMPTY_VALUE } from "@maple/ui/lib/format"
import { formatRelativeShortFrom } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import {
	displaySignalType,
	formatAlertDuration,
	formatResolutionDuration,
	formatSignalValue,
} from "@maple/web-data/alerts/form-utils"
import { quietForMs, type RuleHeadroom, ruleHeadroom } from "@maple/web-data/alerts/headroom"
import type { AlertsOverviewReady } from "@maple/web-data/alerts/overview"
import {
	type BlindSpot,
	type BlindSpotKind,
	blindSpots as deriveBlindSpots,
	type FireLane,
	fireLanes,
	incidentTitle,
} from "@maple/web-data/alerts/overview-derive"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { severityBadge } from "../shared/badges"
import { incidentHref, ROW_STRETCHED_LINK_CLASS, ruleHref } from "../shared/links"
import { sortIncidents } from "../shared/sort"
import { isoMs, msIso } from "../shared/time"

// `InboxTab` and `HeadroomList`: the hub's Inbox tab.

const HOUR_MS = 60 * 60 * 1000
const INCIDENT_GRID = "grid grid-cols-[minmax(0,1fr)_150px_90px] items-center gap-4"
const MAX_LANES = 8
const MAX_HEADROOM_ROWS = 8
const HEADROOM_GRID = "grid grid-cols-[minmax(0,220px)_minmax(0,1fr)_130px_44px] items-center gap-4"
const SECTIONS_GRID = "grid gap-8 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"

type Range = Readonly<{ min: number; max: number }>

export const inboxTab = <M>(h: HtmlBuilder<M>, data: AlertsOverviewReady): Html => {
	const { rules, incidents, openIncidents, derivedByRuleId, statesByRule, timelineRange } = data
	const now = timelineRange.max
	const all = sortIncidents(openIncidents)
	const sorted = [...all.filter((i) => i.holdReason === null), ...all.filter((i) => i.holdReason !== null)]
	const spots = deriveBlindSpots(rules, derivedByRuleId)
	const lanes = fireLanes(incidents, timelineRange)
	const held = sorted.filter((i) => i.holdReason !== null).length
	const firing = sorted.length - held
	const enabledRuleIds = rules.filter((r) => r.enabled).map((r) => r.id)
	const disabled = rules.length - enabledRuleIds.length
	const isQuiet = sorted.length === 0

	const summary = [
		`${countLabel(enabledRuleIds.length, "rule")} watching`,
		spots.length > 0 ? `${spots.length} can't fire or notify` : "all evaluating and routed",
		...(disabled > 0 ? [`${disabled} disabled`] : []),
	].join(" · ")

	const sections = h.div(
		[h.Class(SECTIONS_GRID)],
		[fireStrip(h, lanes, incidents, timelineRange, enabledRuleIds), blindSpotsList(h, spots)],
	)

	return h.div(
		[h.Class("space-y-8")],
		[
			h.div(
				[h.Class("space-y-1.5")],
				[
					h.h2(
						[h.Class("text-2xl font-semibold tracking-tight tabular-nums")],
						[
							isQuiet ? "Nothing firing" : `${firing} firing`,
							...(isQuiet ? [quietStreak(h, incidents, now)] : []),
							...(held > 0
								? [
										h.span(
											[h.Class("text-muted-foreground font-normal")],
											[" · ", String(held), " waiting on data"],
										),
									]
								: []),
						],
					),
					h.p([h.Class("text-muted-foreground font-mono text-xs")], [summary]),
				],
			),
			...(isQuiet
				? [
						headroomList(h, ruleHeadroom(rules, statesByRule), now),
						lanes.length === 0 && spots.length === 0
							? h.p(
									[h.Class("font-mono text-xs text-muted-foreground")],
									[
										"No rule fired in the last 24 hours · no blind spots: every enabled rule is evaluating and routed.",
									],
								)
							: sections,
					]
				: [openIncidentsList(h, sorted, now), sections]),
		],
	)
}

const quietStreak = <M>(
	h: HtmlBuilder<M>,
	incidents: ReadonlyArray<AlertIncidentDocument>,
	now: number,
): Html => {
	const quietFor = quietForMs(incidents, now)
	return h.span(
		[h.Class("font-normal text-muted-foreground")],
		[" · ", quietFor === null ? "quiet for 24h+" : `quiet for ${formatResolutionDuration(quietFor)}`],
	)
}

// OPEN INCIDENTS

const openIncidentsList = <M>(
	h: HtmlBuilder<M>,
	incidents: ReadonlyArray<AlertIncidentDocument>,
	now: number,
) =>
	h.div(
		[h.Class("overflow-x-auto rounded-md border")],
		[
			h.div(
				[h.Class("min-w-[560px]")],
				[
					h.div(
						[h.Class(cn(INCIDENT_GRID, "border-b px-4 py-2 text-xs text-muted-foreground"))],
						[
							h.span([], ["Open · ", String(incidents.length)]),
							h.span([], ["Now / threshold"]),
							h.span([], ["Open for"]),
						],
					),
					h.ul(
						[h.Class("divide-y")],
						incidents.map((incident) => openIncidentRow(h, incident, now)),
					),
				],
			),
		],
	)

const openIncidentRow = <M>(h: HtmlBuilder<M>, incident: AlertIncidentDocument, now: number): Html => {
	const isHeld = incident.holdReason !== null
	const tone = incident.severity === "critical" ? "text-severity-error" : "text-severity-warn"
	return h.li(
		[h.Key(incident.id), h.Class(cn(INCIDENT_GRID, "relative px-4 py-3 hover:bg-muted/40"))],
		[
			h.span([
				h.AriaHidden(true),
				h.Class(
					cn(
						"absolute inset-y-2 left-0 w-0.5 rounded-full",
						isHeld
							? "bg-muted-foreground/50"
							: incident.severity === "critical"
								? "bg-severity-error"
								: "bg-severity-warn",
					),
				),
			]),
			h.div(
				[h.Class("min-w-0 space-y-1")],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							isHeld
								? badge(h, { variant: "outline", className: "text-muted-foreground" }, [
										"Held",
									])
								: severityBadge(h, incident.severity),
							h.a(
								[
									h.Class(cn("min-w-0 truncate font-medium", ROW_STRETCHED_LINK_CLASS)),
									h.Href(incidentHref(incident.id)),
									h.Title(incidentTitle(incident)),
								],
								[isHeld ? `${incident.ruleName}: waiting on data` : incidentTitle(incident)],
							),
						],
					),
					h.p(
						[h.Class("truncate text-xs text-muted-foreground")],
						[
							incident.ruleName,
							...(incident.groupKey !== null ? [` · ${incident.groupKey}`] : []),
						],
					),
				],
			),
			h.span(
				[h.Class("font-mono text-xs tabular-nums")],
				[
					isHeld
						? h.span([h.Class("text-muted-foreground")], ["no data"])
						: h.span(
								[h.Class(tone)],
								[formatSignalValue(incident.signalType, incident.lastObservedValue)],
							),
					h.span(
						[h.Class("text-muted-foreground")],
						[" / ", formatSignalValue(incident.signalType, incident.threshold)],
					),
				],
			),
			h.span(
				[h.Class("font-mono text-xs tabular-nums")],
				[formatAlertDuration(incident.firstTriggeredAt, msIso(now))],
			),
		],
	)
}

// LAST 24 HOURS

const fireStrip = <M>(
	h: HtmlBuilder<M>,
	lanes: ReadonlyArray<FireLane>,
	incidents: ReadonlyArray<AlertIncidentDocument>,
	range: Range,
	enabledRuleIds: ReadonlyArray<string>,
): Html => {
	const inWindow = incidents.filter((i) => isoMs(i.firstTriggeredAt) >= range.min)
	const resolved = inWindow.filter((i) => i.resolvedAt !== null)
	const mttr =
		resolved.length === 0
			? EMPTY_VALUE
			: formatResolutionDuration(
					resolved.reduce(
						(sum, i) =>
							sum + (isoMs(i.resolvedAt ?? i.firstTriggeredAt) - isoMs(i.firstTriggeredAt)),
						0,
					) / resolved.length,
				)
	const shown = lanes.slice(0, MAX_LANES)
	const fired = new Set(lanes.map((lane) => lane.ruleId))
	const quiet = enabledRuleIds.filter((id) => !fired.has(id)).length
	const hiddenFired = lanes.length - shown.length
	const footer = [
		hiddenFired > 0 ? `+ ${hiddenFired} more fired` : null,
		quiet > 0 ? countLabel(quiet, "quiet rule") : null,
	]
		.filter((part) => part !== null)
		.join(" · ")
	const span = range.max - range.min

	return h.section(
		[h.Class("space-y-3")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-4")],
				[
					eyebrow(h, { as: "h3" }, ["Last 24 hours"]),
					h.span(
						[h.Class("font-mono text-xs text-muted-foreground")],
						[
							countLabel(inWindow.length, "incident"),
							" · MTTR ",
							mttr,
							" ·",
							" ",
							countLabel(lanes.length, "rule"),
							" fired",
						],
					),
				],
			),
			shown.length === 0
				? h.p(
						[h.Class("border-t py-4 text-sm text-muted-foreground")],
						["No rule fired in the last 24 hours."],
					)
				: h.ul(
						[h.Class("divide-y border-y")],
						shown.map((lane) => fireLaneRow(h, lane)),
					),
			h.div(
				[
					h.Class(
						"grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-4 font-mono text-2xs text-muted-foreground",
					),
				],
				[
					h.span([], [footer]),
					h.div(
						[h.Class("flex justify-between")],
						[
							h.span([], [String(Math.round(span / HOUR_MS)), "h ago"]),
							h.span([], [String(Math.round(span / HOUR_MS / 2)), "h ago"]),
							h.span([], ["Now"]),
						],
					),
				],
			),
		],
	)
}

const fireLaneRow = <M>(h: HtmlBuilder<M>, lane: FireLane): Html =>
	h.li(
		[
			h.Key(lane.ruleId),
			h.Class("grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-center gap-4 py-2"),
		],
		[
			h.a(
				[
					h.Class("truncate text-sm hover:underline"),
					h.Href(ruleHref(lane.ruleId)),
					h.Title(lane.ruleName),
				],
				[lane.ruleName],
			),
			h.div(
				[h.Class("relative h-2.5 rounded-xs bg-muted/60")],
				lane.bars.map((bar) =>
					h.span([
						h.Key(bar.id),
						h.Class(
							cn(
								"absolute inset-y-0 rounded-xs",
								bar.held
									? "bg-muted-foreground/60"
									: bar.severity === "critical"
										? "bg-severity-error"
										: "bg-severity-warn",
								!bar.open && "opacity-70",
							),
						),
						h.Style({ left: `${bar.start * 100}%`, width: `${(bar.end - bar.start) * 100}%` }),
					]),
				),
			),
		],
	)

// BLIND SPOTS

const BLIND_SPOT_META = new Map<BlindSpotKind, { label: string; action: string; className: string }>([
	["error", { label: "Error", action: "Fix", className: "text-severity-error" }],
	["stale", { label: "Stale", action: "Check", className: "text-severity-warn" }],
	["no-data", { label: "No data", action: "Tune", className: "text-muted-foreground" }],
	["unrouted", { label: "Unrouted", action: "Route", className: "text-muted-foreground" }],
	["delivery", { label: "Delivery", action: "Check", className: "text-severity-warn" }],
])

const blindSpotsList = <M>(h: HtmlBuilder<M>, spots: ReadonlyArray<BlindSpot>): Html =>
	h.section(
		[h.Class("space-y-3")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-4")],
				[
					eyebrow(h, { as: "h3" }, ["Blind spots"]),
					h.span(
						[h.Class("font-mono text-xs text-muted-foreground")],
						["rules that can't fire or notify"],
					),
				],
			),
			spots.length === 0
				? h.p(
						[h.Class("border-t py-4 text-sm text-muted-foreground")],
						["Every enabled rule is evaluating and routed somewhere."],
					)
				: h.ul(
						[h.Class("divide-y border-t")],
						spots.map((spot) => blindSpotRow(h, spot)),
					),
		],
	)

const blindSpotRow = <M>(h: HtmlBuilder<M>, spot: BlindSpot): Html => {
	const meta = BLIND_SPOT_META.get(spot.kind) ?? { label: spot.kind, action: "Check", className: "" }
	return h.li(
		[
			h.Key(spot.rule.id),
			h.Class(
				"relative grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-4 py-2.5 hover:bg-muted/40",
			),
		],
		[
			h.span([h.Class(cn("font-mono text-xs", meta.className))], [meta.label]),
			h.div(
				[h.Class("min-w-0")],
				[
					h.p([h.Class("truncate text-sm")], [spot.rule.name]),
					h.p(
						[h.Class("truncate text-xs text-muted-foreground"), h.Title(spot.detail)],
						[spot.detail],
					),
				],
			),
			h.a(
				[
					h.Class(cn("text-xs font-medium text-primary", ROW_STRETCHED_LINK_CLASS)),
					h.Href(ruleHref(spot.rule.id)),
				],
				[meta.action],
			),
		],
	)
}

// HEADROOM

const ruleValue = (rule: AlertRuleDocument, value: number): string => {
	const draft = rule.queryBuilderDraft
	return formatSignalValue(
		displaySignalType({
			signalType: rule.signalType,
			queryBuilderDraft:
				draft == null
					? undefined
					: { dataSource: draft.dataSource ?? "", aggregation: draft.aggregation ?? "" },
		}),
		value,
	)
}

const headroomList = <M>(h: HtmlBuilder<M>, rows: ReadonlyArray<RuleHeadroom>, now: number): Html => {
	const shown = rows.slice(0, MAX_HEADROOM_ROWS)
	const hidden = rows.length - shown.length
	return h.section(
		[h.Class("space-y-3")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-4")],
				[
					eyebrow(h, { as: "h3" }, ["Headroom"]),
					h.span(
						[h.Class("font-mono text-xs text-muted-foreground")],
						["latest check against each threshold"],
					),
				],
			),
			shown.length === 0
				? h.p(
						[h.Class("border-t py-4 text-sm text-muted-foreground")],
						["No rule has reported a value yet. The first checks land within a minute."],
					)
				: h.ul(
						[h.Class("divide-y border-y")],
						shown.map((row) => headroomRow(h, row, now)),
					),
			...(hidden > 0
				? [
						h.p(
							[h.Class("font-mono text-2xs text-muted-foreground")],
							["+ ", countLabel(hidden, "more rule")],
						),
					]
				: []),
		],
	)
}

const headroomRow = <M>(h: HtmlBuilder<M>, row: RuleHeadroom, now: number): Html => {
	const { rule, closeness } = row
	const isNear = closeness !== null && closeness >= 0.75
	const isFloor = rule.comparator === "lt" || rule.comparator === "lte"
	return h.li(
		[h.Key(rule.id), h.Class(cn(HEADROOM_GRID, "relative py-2.5 hover:bg-muted/40"))],
		[
			h.div(
				[h.Class("min-w-0")],
				[
					h.a(
						[
							h.Class(cn("block truncate text-sm", ROW_STRETCHED_LINK_CLASS)),
							h.Href(ruleHref(rule.id)),
							h.Title(rule.name),
						],
						[rule.name],
					),
					...(row.groupKey !== null
						? [
								h.p(
									[h.Class("truncate font-mono text-2xs text-muted-foreground")],
									[row.groupKey],
								),
							]
						: []),
				],
			),
			h.div(
				[h.Class("relative h-2 rounded-xs bg-muted/60"), h.AriaHidden(true)],
				[
					...(closeness !== null
						? [
								h.span([
									h.Class(
										cn(
											"absolute inset-y-0 left-0 rounded-xs",
											isNear ? "bg-severity-warn" : "bg-muted-foreground/45",
										),
									),
									h.Style({ width: `${Math.max(closeness * 100, 1.5)}%` }),
								]),
							]
						: []),
					h.span([
						h.AriaHidden(true),
						h.Class(
							cn(
								"absolute -inset-y-1 right-0 w-0.5 rounded-full",
								rule.severity === "critical" ? "bg-severity-error" : "bg-severity-warn",
							),
						),
					]),
				],
			),
			h.span(
				[h.Class("truncate text-right font-mono text-xs tabular-nums")],
				[
					h.span(isNear ? [h.Class("text-severity-warn")] : [], [ruleValue(rule, row.value)]),
					h.span(
						[h.Class("text-muted-foreground")],
						[isFloor ? " / min " : " / ", ruleValue(rule, rule.threshold)],
					),
				],
			),
			h.span(
				[h.Class("text-right font-mono text-2xs text-muted-foreground")],
				[row.checkedAt === null ? "" : formatRelativeShortFrom(row.checkedAt, now)],
			),
		],
	)
}
