import type { AlertIncidentDocument, AlertIncidentId, AlertRuleDocument } from "@maple/domain/http"
import { acknowledgedLine } from "@maple/web-data/alerts/incident-timeline"
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
	incidentSubline,
	incidentTitle,
	incidentValues,
} from "@maple/web-data/alerts/overview-derive"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { heading } from "@maple/views/ui/heading"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { ROW_LINK_LIFT, rowLink } from "@maple/views/ui/table"
import { severityBadge } from "../shared/badges"
import { incidentHref, ruleHref } from "../shared/links"
import { sortIncidents } from "../shared/sort"
import { isoMs, msIso } from "../shared/time"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { stripClass } from "@maple/views/ui/rule"
import { hstack } from "@maple/views/ui/stack"
import { barFillClass } from "@maple/views/ui/meter"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { Array as Arr } from "effect"

// `InboxTab` and `HeadroomList`: the hub's Inbox tab.

const HOUR_MS = 60 * 60 * 1000
const INCIDENT_GRID = "grid grid-cols-[minmax(0,1fr)_150px_90px_120px] items-center gap-4"
const MAX_LANES = 8
const MAX_HEADROOM_ROWS = 8
const HEADROOM_GRID = "grid grid-cols-[minmax(0,220px)_minmax(0,1fr)_130px_44px] items-center gap-4"
const SECTIONS_GRID = "grid gap-8 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"

type Range = Readonly<{ min: number; max: number }>

/** The inbox rows' acknowledge button: the message it sends, and the rows with a request in flight. */
export type InboxAcknowledge<M> = Readonly<{
	onAcknowledge: (incidentId: AlertIncidentId, acknowledged: boolean) => M
	pendingIds: ReadonlyArray<AlertIncidentId>
}>

const isAcknowledged = (incident: AlertIncidentDocument) => incident.acknowledgedAt !== null

export const inboxTab = <M>(
	h: HtmlBuilder<M>,
	data: AlertsOverviewReady,
	acknowledge: InboxAcknowledge<M>,
): Html => {
	const { rules, incidents, openIncidents, derivedByRuleId, statesByRule, timelineRange } = data
	const now = timelineRange.max
	const all = sortIncidents(openIncidents)
	// What still needs someone first, then what someone is on, then what waits on data.
	const sorted = [
		...Arr.filter(all, (i) => i.holdReason === null && !isAcknowledged(i)),
		...Arr.filter(all, (i) => i.holdReason === null && isAcknowledged(i)),
		...Arr.filter(all, (i) => i.holdReason !== null),
	]
	const spots = deriveBlindSpots(rules, derivedByRuleId)
	const lanes = fireLanes(incidents, timelineRange)
	const held = Arr.filter(sorted, (i) => i.holdReason !== null).length
	const acknowledged = Arr.filter(sorted, (i) => i.holdReason === null && isAcknowledged(i)).length
	const firing = sorted.length - held - acknowledged
	const enabledRuleIds = Arr.map(
		Arr.filter(rules, (r) => r.enabled),
		(r) => r.id,
	)
	const disabled = rules.length - enabledRuleIds.length
	const isQuiet = sorted.length === 0

	const summary = Arr.join(
		[
			`${countLabel(enabledRuleIds.length, "rule")} watching`,
			spots.length > 0
				? `${spots.length} ${spots.length === 1 ? "needs" : "need"} a look`
				: "all evaluating and routed",
			...(disabled > 0 ? [`${disabled} disabled`] : []),
		],
		" · ",
	)

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
					heading(h, { level: 2, variant: "title", className: "tabular-nums" }, [
						isQuiet ? "Nothing firing" : `${firing} firing`,
						...(isQuiet ? [quietStreak(h, incidents, now)] : []),
						...(acknowledged > 0
							? [
									typography(h, { tone: "muted", weight: "normal" }, [
										" · ",
										String(acknowledged),
										" acknowledged",
									]),
								]
							: []),
						...(held > 0
							? [
									typography(h, { tone: "muted", weight: "normal" }, [
										" · ",
										String(held),
										" waiting on data",
									]),
								]
							: []),
					]),
					typography(h, { size: "xs", tone: "muted", mono: true, as: "p" }, [summary]),
				],
			),
			...(isQuiet
				? [
						headroomList(h, ruleHeadroom(rules, statesByRule), now),
						lanes.length === 0 && spots.length === 0
							? typography(h, { size: "xs", tone: "muted", mono: true, as: "p" }, [
									"No rule fired in the last 24 hours · no blind spots: every enabled rule is evaluating and routed.",
								])
							: sections,
					]
				: [openIncidentsList(h, sorted, now, acknowledge), sections]),
		],
	)
}

const quietStreak = <M>(
	h: HtmlBuilder<M>,
	incidents: ReadonlyArray<AlertIncidentDocument>,
	now: number,
): Html => {
	const quietFor = quietForMs(incidents, now)
	return typography(h, { tone: "muted", weight: "normal" }, [
		" · ",
		quietFor === null ? "quiet for 24h+" : `quiet for ${formatResolutionDuration(quietFor)}`,
	])
}

// OPEN INCIDENTS

const openIncidentsList = <M>(
	h: HtmlBuilder<M>,
	incidents: ReadonlyArray<AlertIncidentDocument>,
	now: number,
	acknowledge: InboxAcknowledge<M>,
) =>
	borderedBox(h, { overflow: "x-auto" }, [
		h.div(
			[h.Class("min-w-[680px]")],
			[
				h.div(
					[
						h.Class(
							cn(
								INCIDENT_GRID,
								typographyClass({ size: "xs", tone: "muted", className: stripClass("head") }),
							),
						),
					],
					[
						h.span([], ["Open · ", String(incidents.length)]),
						h.span([], ["Now / threshold"]),
						h.span([], ["Open for"]),
						h.span([h.Class("sr-only")], ["Acknowledge"]),
					],
				),
				h.ul(
					[h.Class("divide-y")],
					Arr.map(incidents, (incident) => openIncidentRow(h, incident, now, acknowledge)),
				),
			],
		),
	])

const openIncidentRow = <M>(
	h: HtmlBuilder<M>,
	incident: AlertIncidentDocument,
	now: number,
	acknowledge: InboxAcknowledge<M>,
): Html => {
	const isHeld = incident.holdReason !== null
	const acked = acknowledgedLine(incident)
	const tone = incident.severity === "critical" ? "text-severity-error" : "text-severity-warn"
	return h.li(
		[
			h.Key(incident.id),
			h.Class(cn(INCIDENT_GRID, "relative px-4 py-3 hover:bg-surface-sunken active:bg-surface-sunken")),
		],
		[
			h.span([
				h.AriaHidden(true),
				h.Class(
					cn(
						"absolute inset-y-2 left-0 w-0.5 rounded-full",
						isHeld || acked !== null
							? "bg-foreground-subtle"
							: incident.severity === "critical"
								? "bg-severity-error"
								: "bg-severity-warn",
					),
				),
			]),
			h.div(
				[h.Class("min-w-0 space-y-1")],
				[
					hstack(h, { gap: "2", shrink: true }, [
						isHeld
							? badge(h, { variant: "outline", className: "text-muted-foreground" }, ["Held"])
							: severityBadge(h, incident.severity),
						rowLink(
							h,
							{
								href: incidentHref(incident.id),
								className: "min-w-0 truncate font-medium",
								attributes: [h.Title(incidentTitle(incident))],
							},
							[isHeld ? `${incident.ruleName}: waiting on data` : incidentTitle(incident)],
						),
					]),
					typography(h, { size: "xs", tone: "muted", truncate: true, as: "p" }, [
						acked === null
							? incidentSubline(incident)
							: `${acked} · ${incidentSubline(incident)}`,
					]),
				],
			),
			typography(h, { size: "xs", mono: true, numeric: true }, [
				isHeld
					? h.span([h.Class("text-muted-foreground")], ["no data"])
					: h.span([h.Class(tone)], [incidentValues(incident).now]),
				h.span([h.Class("text-muted-foreground")], [" / ", incidentValues(incident).threshold]),
			]),
			typography(h, { size: "xs", mono: true, numeric: true }, [
				formatAlertDuration(incident.firstTriggeredAt, msIso(now)),
			]),
			// Lifted above the row's stretched link, so the click acknowledges instead of navigating.
			hstack(h, { justify: "end", className: ROW_LINK_LIFT }, [
				button(
					h,
					{
						variant: acked === null ? "outline" : "ghost",
						size: "xs",
						isLoading: acknowledge.pendingIds.includes(incident.id),
						attributes: [
							h.OnClick(acknowledge.onAcknowledge(incident.id, acked === null)),
							h.AriaLabel(
								`${acked === null ? "Acknowledge" : "Unacknowledge"} ${incidentTitle(incident)}`,
							),
						],
					},
					acked === null ? [icon(h, "CheckIcon"), "Acknowledge"] : ["Unacknowledge"],
				),
			]),
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
	const inWindow = Arr.filter(incidents, (i) => isoMs(i.firstTriggeredAt) >= range.min)
	const resolved = Arr.filter(inWindow, (i) => i.resolvedAt !== null)
	const mttr =
		resolved.length === 0
			? EMPTY_VALUE
			: formatResolutionDuration(
					Arr.reduce(
						resolved,
						0,
						(sum, i) =>
							sum + (isoMs(i.resolvedAt ?? i.firstTriggeredAt) - isoMs(i.firstTriggeredAt)),
					) / resolved.length,
				)
	const shown = lanes.slice(0, MAX_LANES)
	const fired = new Set(Arr.map(lanes, (lane) => lane.ruleId))
	const quiet = Arr.filter(enabledRuleIds, (id) => !fired.has(id)).length
	const hiddenFired = lanes.length - shown.length
	const footer = Arr.join(
		Arr.filter(
			[
				hiddenFired > 0 ? `+ ${hiddenFired} more fired` : null,
				quiet > 0 ? countLabel(quiet, "quiet rule") : null,
			],
			(part) => part !== null,
		),
		" · ",
	)
	const span = range.max - range.min

	return h.section(
		[h.Class("space-y-3")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-4")],
				[
					eyebrow(h, { as: "h3" }, ["Last 24 hours"]),
					typography(h, { size: "xs", tone: "muted", mono: true }, [
						countLabel(inWindow.length, "incident"),
						" · MTTR ",
						mttr,
						" ·",
						" ",
						countLabel(lanes.length, "rule"),
						" fired",
					]),
				],
			),
			shown.length === 0
				? emptyMessage(h, { className: "border-t" }, ["No rule fired in the last 24 hours"])
				: h.ul(
						[h.Class("divide-y border-y")],
						Arr.map(shown, (lane) => fireLaneRow(h, lane)),
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
					h.Class("truncate text-sm hover:underline active:underline"),
					h.Href(ruleHref(lane.ruleId)),
					h.Title(lane.ruleName),
				],
				[lane.ruleName],
			),
			h.div(
				[h.Class("relative h-2.5 rounded-xs bg-surface-strong")],
				Arr.map(lane.bars, (bar) =>
					h.span([
						h.Key(bar.id),
						h.Class(
							cn(
								"absolute inset-y-0 rounded-xs",
								bar.held
									? "bg-foreground-subtle"
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
	["no-data", { label: "No data", action: "Tune", className: "text-severity-warn" }],
	["slowed", { label: "Slowed down", action: "Fix query", className: "text-severity-warn" }],
	["unrouted", { label: "Unrouted", action: "Route", className: "text-severity-warn" }],
	["delivery", { label: "Delivery", action: "Check", className: "text-severity-warn" }],
])

const blindSpotsList = <M>(h: HtmlBuilder<M>, spots: ReadonlyArray<BlindSpot>): Html =>
	h.section(
		[h.Class("space-y-3")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-4")],
				[
					eyebrow(h, { as: "h3", className: "shrink-0 whitespace-nowrap" }, ["Blind spots"]),
					h.span(
						[h.Class("min-w-0 truncate font-prose text-xs text-muted-foreground")],
						["Rules that can't fire, notify or keep up"],
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
						Arr.map(spots, (spot) => blindSpotRow(h, spot)),
					),
		],
	)

const blindSpotRow = <M>(h: HtmlBuilder<M>, spot: BlindSpot): Html => {
	const meta = BLIND_SPOT_META.get(spot.kind) ?? { label: spot.kind, action: "Check", className: "" }
	return h.li(
		[
			h.Key(spot.rule.id),
			h.Class(
				"group relative grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-4 py-2.5 hover:bg-surface-sunken active:bg-surface-sunken",
			),
		],
		[
			h.span([h.Class(cn(typographyClass({ size: "xs", mono: true }), meta.className))], [meta.label]),
			h.div(
				[h.Class("min-w-0")],
				[
					typography(h, { size: "sm", truncate: true, as: "p" }, [spot.rule.name]),
					typography(
						h,
						{
							size: "xs",
							tone: "muted",
							truncate: true,
							as: "p",
							className: "font-prose",
							attributes: [h.Title(spot.detail)],
						},
						[spot.detail],
					),
				],
			),
			rowLink(
				h,
				{
					href: ruleHref(spot.rule.id),
					className:
						"inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground group-hover:bg-accent",
				},
				[meta.action, icon(h, "ArrowRightIcon", { className: "size-3 text-muted-foreground" })],
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
					typography(h, { size: "xs", tone: "muted", mono: true }, [
						"latest check against each threshold",
					]),
				],
			),
			shown.length === 0
				? emptyMessage(h, { className: "border-t" }, [
						"No rule has reported a value yet. The first checks land within a minute.",
					])
				: h.ul(
						[h.Class("divide-y border-y")],
						Arr.map(shown, (row) => headroomRow(h, row, now)),
					),
			...(hidden > 0
				? [
						typography(h, { size: "2xs", tone: "muted", mono: true, as: "p" }, [
							"+ ",
							countLabel(hidden, "more rule"),
						]),
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
		[
			h.Key(rule.id),
			h.Class(cn(HEADROOM_GRID, "relative py-2.5 hover:bg-surface-sunken active:bg-surface-sunken")),
		],
		[
			h.div(
				[h.Class("min-w-0")],
				[
					rowLink(
						h,
						{
							href: ruleHref(rule.id),
							className: "block truncate text-sm",
							attributes: [h.Title(rule.name)],
						},
						[rule.name],
					),
					...(row.groupKey !== null
						? [
								typography(
									h,
									{ size: "2xs", tone: "muted", mono: true, truncate: true, as: "p" },
									[row.groupKey],
								),
							]
						: []),
				],
			),
			h.div(
				[h.Class("relative h-2 rounded-xs bg-surface-strong"), h.AriaHidden(true)],
				[
					...(closeness !== null
						? [
								h.span([
									h.Class(
										barFillClass(isNear ? "bg-severity-warn" : "bg-foreground-faint"),
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
