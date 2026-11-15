import { cn } from "@maple/ui/lib/utils"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import type { PlotGeometry } from "@maple/views/charts/chart"
import * as HoverCard from "@maple/views/ui/hover-card"
import { truncatedText } from "@maple/views/ui/truncated-text"
import type { LabelGroup } from "./marker-layout"
import { type MarkerCard, markerCardBody } from "./marker-card"
import type { MarkerLayout } from "./markers"
import { Array as Arr } from "effect"

// Commit markers over a chart. With a `MarkerCard`, hovering a label (or a dash, when the chart is
// too dense for labels) opens the card listing every commit in that group.

const LABEL_HEIGHT = 18
const LABEL_GAP = 4
const DASH_HIT = 5

const px = (value: number) => `${value}px`

/**
 * What a marker overlay draws: both, or (for charts stacked on one time axis) the dashes on each chart
 * and the labels once, in a lane above them.
 */
export type MarkerPart = "all" | "dashes" | "labels"

/** A page's card, and the overlay's own scope so its trigger ids stay unique across charts. */
export type MarkerOverlayCard<M> = MarkerCard<M> & Readonly<{ scope: string }>

type Triggers = Readonly<{
	label: (groupIndex: number) => ReadonlyArray<ChildAttribute>
	dash: (groupIndex: number, dashIndex: number) => ReadonlyArray<ChildAttribute>
}>

const NO_TRIGGERS: Triggers = { label: () => [], dash: () => [] }

/** A commit's tone on the chart: a flagged deploy's marker draws in it, the rest stay quiet. */
export type MarkerTone = (sha: string) => "crit" | "warn" | undefined

const DASH_TONE = { crit: "border-severity-error opacity-80", warn: "border-severity-warn opacity-80" }
const LABEL_TONE = { crit: "border-severity-error-a3", warn: "border-severity-warn-a3" }

/** The group's worst tone: one flagged commit among several still marks the group. */
const groupTone = (group: LabelGroup, toneOf: MarkerTone | undefined): "crit" | "warn" | undefined => {
	if (toneOf === undefined) return undefined
	const tones = Arr.map(group.commits, (commit) => toneOf(commit.sha))
	return tones.includes("crit") ? "crit" : tones.includes("warn") ? "warn" : undefined
}

const labelTriggerId = (scope: string, groupIndex: number) => `${scope}-marker-${groupIndex}-label`
const dashTriggerId = (scope: string, groupIndex: number, dashIndex: number) =>
	`${scope}-marker-${groupIndex}-dash-${dashIndex}`

const groupChildren = <M>(
	h: HtmlBuilder<M>,
	layout: MarkerLayout,
	plot: PlotGeometry,
	labelGap: number,
	part: MarkerPart,
	group: LabelGroup,
	groupIndex: number,
	triggers: Triggers,
	hasCard: boolean,
	tone: "crit" | "warn" | undefined,
): ReadonlyArray<Html> => {
	const labelTop = plot.y - LABEL_HEIGHT - labelGap
	const reachesLabel = layout.labeled && part === "all"
	const dashTop = reachesLabel ? plot.y - labelGap : plot.y
	const dashHeight = reachesLabel ? Math.max(plot.height + labelGap, 0) : plot.height
	const badge = group.commits.length - 1
	const dashes = Arr.map(group.dashXs, (x, index) =>
		h.div(
			[
				h.Key(`${group.key}-dash-${index}`),
				h.DataAttribute("commit-marker-dash", ""),
				h.Class(cn("group/dash pointer-events-auto", hasCard && !layout.labeled && "cursor-pointer")),
				...triggers.dash(groupIndex, index),
				h.Style({
					position: "absolute",
					left: px(x - DASH_HIT),
					top: px(dashTop),
					width: px(DASH_HIT * 2),
					height: px(dashHeight),
					display: "flex",
					"justify-content": "center",
				}),
			],
			[
				h.div([
					h.Class(
						cn(
							"h-full w-0 border-l border-dashed transition-opacity duration-100",
							tone === undefined ? "border-muted-foreground opacity-40" : DASH_TONE[tone],
							hasCard &&
								"group-hover/dash:opacity-100 group-data-[popup-open]/dash:opacity-100",
						),
					),
				]),
			],
		),
	)
	const label = h.div(
		[
			h.Key(`${group.key}-label`),
			h.DataAttribute("commit-marker-label", ""),
			...(hasCard ? triggers.label(groupIndex) : [h.Title(group.label)]),
			h.Style({
				position: "absolute",
				left: px(group.boxLeft),
				top: px(labelTop),
				width: px(group.boxWidth),
				height: px(LABEL_HEIGHT),
			}),
			h.Class(
				cn(
					"pointer-events-auto flex cursor-pointer items-center justify-center gap-1 rounded-sm border px-1.5 font-mono text-2xs leading-none backdrop-blur-sm",
					tone === undefined ? "border-border-subtle" : LABEL_TONE[tone],
					"bg-surface-float text-muted-foreground hover:text-popover-foreground active:text-popover-foreground",
					"data-[popup-open]:border-border data-[popup-open]:text-popover-foreground",
				),
			),
		],
		[
			truncatedText(h, { text: group.label }, [group.label]),
			...(badge > 0
				? [
						h.span(
							[
								h.Class(
									cn(
										"shrink-0 rounded-xs px-1 text-3xs tabular-nums",
										"bg-surface-strong text-muted-foreground",
									),
								),
							],
							[`+${Math.min(badge, 99)}`],
						),
					]
				: []),
		],
	)
	return [...(part === "labels" ? [] : dashes), ...(layout.labeled && part !== "dashes" ? [label] : [])]
}

/** `labelGap` lifts the labels clear of the plot, into a gutter the chart reserves above it. */
export const markersOverlay = <M>(
	h: HtmlBuilder<M>,
	layout: MarkerLayout,
	plot: PlotGeometry,
	labelGap: number = LABEL_GAP,
	part: MarkerPart = "all",
	card?: MarkerOverlayCard<M>,
	toneOf?: MarkerTone,
): Html => {
	if (layout.groups.length === 0) return null
	const overlay = (triggers: Triggers, portal: Html) =>
		h.div(
			[h.DataAttribute("commit-markers", ""), h.Class(cn("absolute inset-0", "pointer-events-none"))],
			[
				...Arr.flatMap(layout.groups, (group, index) =>
					groupChildren(
						h,
						layout,
						plot,
						labelGap,
						part,
						group,
						index,
						triggers,
						card !== undefined,
						groupTone(group, toneOf),
					),
				),
				...(portal === null ? [] : [portal]),
			],
		)
	if (card === undefined) return overlay(NO_TRIGGERS, null)
	// Labels open the card when they are drawn; a dense chart's dashes open it instead.
	const labelsTrigger = layout.labeled && part !== "dashes"
	const dashesTrigger = !layout.labeled && part !== "labels"
	const groupOf = new Map<string, LabelGroup>(
		Arr.flatMap(layout.groups, (group, index): ReadonlyArray<readonly [string, LabelGroup]> => [
			...(labelsTrigger ? [[labelTriggerId(card.scope, index), group] as const] : []),
			...(dashesTrigger
				? Arr.map(group.dashXs, (_, dash) => [dashTriggerId(card.scope, index, dash), group] as const)
				: []),
		]),
	)
	return h.submodel({
		slotId: `${card.scope}-marker-card`,
		model: card.model,
		view: HoverCard.view,
		toParentMessage: card.toParent,
		viewInputs: {
			triggerIds: [...groupOf.keys()],
			className: "w-80 p-0",
			toContent: (triggerId) => {
				const group = groupOf.get(triggerId)
				return group === undefined ? [] : markerCardBody(h, card, group.commits)
			},
			toView: ({ triggerFor, portal }) =>
				overlay(
					{
						label: (index) =>
							labelsTrigger ? triggerFor(labelTriggerId(card.scope, index)) : [],
						dash: (index, dash) =>
							dashesTrigger ? triggerFor(dashTriggerId(card.scope, index, dash)) : [],
					},
					groupOf.has(card.model.triggerId) ? portal : null,
				),
		},
	})
}
