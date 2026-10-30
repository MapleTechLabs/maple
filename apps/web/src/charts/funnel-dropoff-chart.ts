import { pickValueField } from "@maple/ui/components/charts/_shared/breakdown-rows"
import { EMPTY_VALUE, formatPercent } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../ui/eyebrow"
import { icon } from "../ui/icon"
import { Message, type Model } from "./chart"
import { MeasureChartContainer } from "./chart-mounts"
import type { FunnelChartInputs } from "./funnel-chart"
import { fmtValue } from "./funnel-chart"
import { fmtSpan, leaverRows, type Step, toSteps } from "./funnel-dropoff-steps"

// Port of `FunnelDropoffChart` (packages/ui/src/components/charts/funnel/funnel-dropoff-chart.tsx).
// The hovered column is the chart Model's `activeKey` (its index).

type H = HtmlBuilder<Message>

const STEP_MIN_W = 76
const TIP_W = 264
const LOST_CLASS = "bg-foreground/[0.06]"
const STEP_GAP = 12
const PILL_TIME_MIN_W = 150
const PILL_LOSS_MIN_W = 104

const tipRow = (
	h: H,
	glyph: Html,
	label: string,
	value: string,
	share: string | undefined,
	shareClass: string,
): Html =>
	h.div(
		[h.Class("flex items-center justify-between gap-3 py-px tabular-nums")],
		[
			h.span([h.Class("flex items-center gap-1.5 text-muted-foreground")], [glyph, label]),
			h.span(
				[h.Class("flex items-baseline gap-1.5 truncate")],
				[
					h.span([h.Class("font-semibold text-foreground")], [value]),
					...(share === undefined ? [] : [h.span([h.Class(cn("text-3xs", shareClass))], [share])]),
				],
			),
		],
	)

const leaversBlock = (h: H, hovered: Step): ReadonlyArray<Html> =>
	hovered.leavers.length > 0 && hovered.dropped > 0
		? [
				h.div([h.Class("-mx-2.5 my-1.5 h-px bg-border")]),
				eyebrow(h, { as: "div", className: "mb-1 flex items-center gap-1.5" }, [
					icon(h, "ArrowDownIcon", { size: 10, className: TONE_TEXT.crit }),
					"Dropped here went to",
				]),
				...leaverRows(hovered.leavers, hovered.dropped).map((entry) =>
					h.div(
						[h.Class("my-0.5")],
						[
							h.div(
								[h.Class("flex items-center gap-2")],
								[
									h.span(
										[
											h.Class(
												cn(
													"min-w-0 flex-1 truncate",
													entry.ended ? "text-muted-foreground" : "text-foreground-soft",
												),
											),
										],
										[entry.name],
									),
									h.span([h.Class("tabular-nums text-muted-foreground")], [formatPercent(entry.share)]),
								],
							),
							h.div(
								[h.Class("relative mt-0.5 h-1 rounded-sm bg-foreground/5")],
								[
									h.div([
										h.Class(
											cn(
												"absolute inset-y-0 left-0 rounded-sm",
												entry.ended ? "bg-foreground/25" : "bg-chart-2",
											),
										),
										h.Style({ width: `${entry.share * 100}%` }),
									]),
								],
							),
						],
					),
				),
			]
		: []

const tooltip = (h: H, hovered: Step, prev: Step, left: number, unit: string | undefined): Html =>
	h.div(
		[
			h.Class(
				"pointer-events-none absolute top-5 z-10 rounded-lg border bg-popover px-2.5 py-2 text-2xs shadow-md",
			),
			h.Style({ left: `${left}px`, width: `${TIP_W}px` }),
			h.DataAttribute("slot", "funnel-dropoff-tooltip"),
		],
		[
			h.div(
				[h.Class("mb-1.5 flex min-w-0 items-center gap-1.5 font-medium text-foreground")],
				[
					h.span([h.Class("truncate")], [prev.name]),
					icon(h, "ArrowRightIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
					h.span([h.Class("truncate")], [hovered.name]),
				],
			),
			h.div(
				[h.Class("mb-1.5 flex h-1.5 gap-px overflow-hidden rounded-sm")],
				[
					h.div([h.Class("bg-severity-info"), h.Style({ width: `${(hovered.ofPrev ?? 0) * 100}%` })]),
					h.div([h.Class("flex-1 bg-severity-error/70")]),
				],
			),
			tipRow(
				h,
				icon(h, "ArrowRightIcon", { size: 12, className: "text-severity-info" }),
				"converted",
				fmtValue(hovered.value, unit),
				formatPercent(hovered.ofPrev ?? 0),
				"text-severity-info",
			),
			tipRow(
				h,
				icon(h, "ArrowDownIcon", { size: 12, className: TONE_TEXT.crit }),
				"dropped",
				fmtValue(hovered.dropped, unit),
				prev.value > 0 ? formatPercent(hovered.dropped / prev.value) : EMPTY_VALUE,
				TONE_TEXT.crit,
			),
			...(hovered.p50Ms === undefined
				? []
				: [
						tipRow(
							h,
							icon(h, "ClockIcon", { size: 12, className: "text-muted-foreground" }),
							"time between",
							`p50 ${fmtSpan(hovered.p50Ms)}`,
							hovered.p90Ms === undefined ? undefined : `p90 ${fmtSpan(hovered.p90Ms)}`,
							"text-muted-foreground",
						),
					]),
			...leaversBlock(h, hovered),
		],
	)

type ColumnContext = Readonly<{
	steps: ReadonlyArray<Step>
	visible: ReadonlyArray<Step>
	hover: number | null
	isGrouped: boolean
	showPercent: boolean
	pillTime: boolean
	pillLoss: boolean
	unit: string | undefined
}>

const groupBars = (h: H, ctx: ColumnContext, step: Step, index: number): Html =>
	h.div(
		[h.Class("flex h-full items-end gap-0.5")],
		step.groups.map((group) => {
			const max = ctx.steps[0]?.value ?? 1
			const height = group.value / max
			const capH = Math.max(0, (group.prev - group.value) / max)
			return h.div(
				[h.Class("relative h-full flex-1"), h.Title(`${group.name} · ${fmtValue(group.value, ctx.unit)}`)],
				[
					...(index > 0 && capH > 0
						? [
								h.div([
									h.Class(cn("absolute inset-x-0 rounded-xs", LOST_CLASS)),
									h.Style({ bottom: `${height * 100}%`, height: `${capH * 100}%` }),
								]),
							]
						: []),
					h.div([
						h.Class("absolute inset-x-0 bottom-0 rounded-xs"),
						h.Style({ height: `${height * 100}%`, "background-color": group.color }),
					]),
				],
			)
		}),
	)

const plainBars = (h: H, step: Step, prev: Step | undefined): ReadonlyArray<Html> => {
	const capH = prev !== undefined ? Math.max(0, prev.ofFirst - step.ofFirst) : 0
	return [
		...(prev !== undefined && capH > 0
			? [
					h.div([
						h.Class(cn("absolute inset-x-0 rounded-sm", LOST_CLASS)),
						h.Style({ bottom: `${step.ofFirst * 100}%`, height: `${capH * 100}%` }),
						h.DataAttribute("slot", "funnel-dropoff-lost"),
					]),
				]
			: []),
		h.div([
			h.Class("absolute inset-x-0 bottom-0 rounded-sm bg-chart-2"),
			h.Style({
				height: `${Math.max(step.ofFirst * 100, step.value > 0 ? 1.5 : 0)}%`,
				transition: "height 220ms ease",
			}),
			h.DataAttribute("slot", "funnel-dropoff-bar"),
		]),
	]
}

const pill = (h: H, ctx: ColumnContext, step: Step, prev: Step, isLast: boolean): Html => {
	const lostShare = prev.value > 0 ? step.dropped / prev.value : 0
	return h.span(
		[
			h.Class(
				"absolute bottom-1.5 left-1.5 flex items-center gap-2 rounded-md bg-card/95 px-1.5 py-1 text-2xs leading-none tabular-nums whitespace-nowrap shadow-xs ring-1 ring-border-subtle",
			),
			h.DataAttribute("slot", "funnel-dropoff-pill"),
		],
		[
			h.span(
				[h.Class("flex items-center gap-1 font-semibold text-foreground")],
				[
					icon(h, isLast ? "CircleCheckIcon" : "ArrowRightIcon", {
						size: 12,
						className: "text-severity-info",
					}),
					formatPercent(step.ofPrev ?? 0),
				],
			),
			...(ctx.pillLoss && lostShare > 0
				? [
						h.span(
							[h.Class("flex items-center gap-1 text-foreground-soft")],
							[icon(h, "ArrowDownIcon", { size: 12, className: TONE_TEXT.crit }), formatPercent(lostShare)],
						),
					]
				: []),
			...(ctx.pillTime && step.p50Ms !== undefined
				? [
						h.span(
							[h.Class("text-muted-foreground"), h.Title("Median time from the previous step")],
							[fmtSpan(step.p50Ms)],
						),
					]
				: []),
		],
	)
}

const column = (h: H, ctx: ColumnContext, step: Step, index: number): Html => {
	const prev = ctx.visible[index - 1]
	const fade = ctx.hover !== null && ctx.hover !== index ? 0.6 : 1
	const isLast = index === ctx.steps.length - 1
	return h.div(
		[
			h.Class("flex min-w-0 flex-col"),
			h.OnMouseEnter(Message.EnteredLegendItem({ key: String(index) })),
			h.DataAttribute("slot", "funnel-dropoff-step"),
		],
		[
			h.div(
				[h.Class("flex flex-col gap-1 leading-none")],
				[
					h.span(
						[
							h.Class(
								cn(
									"truncate text-2xs font-medium",
									step.unnamed ? "italic text-muted-foreground" : "text-foreground-soft",
								),
							),
							h.Title(step.name),
						],
						[step.name],
					),
					h.span(
						[h.Class("truncate text-base font-semibold tabular-nums text-foreground")],
						[ctx.showPercent ? formatPercent(step.ofFirst) : fmtValue(step.value, ctx.unit)],
					),
					h.span(
						[h.Class("truncate text-2xs tabular-nums text-muted-foreground")],
						[
							ctx.showPercent
								? fmtValue(step.value, ctx.unit)
								: index === 0
									? "entered"
									: "reached",
						],
					),
				],
			),
			h.div(
				[
					h.Class("relative mt-2.5 min-h-0 flex-1"),
					h.Style({ opacity: String(fade), transition: "opacity 140ms ease" }),
				],
				[
					...(ctx.isGrouped ? [groupBars(h, ctx, step, index)] : plainBars(h, step, prev)),
					...(prev !== undefined && ctx.showPercent && step.ofPrev !== null
						? [pill(h, ctx, step, prev, isLast)]
						: []),
				],
			),
		],
	)
}

const header = (h: H, steps: ReadonlyArray<Step>, legend: ReadonlyArray<{ name: string; color: string }>, showPercent: boolean, unit: string | undefined): Html => {
	const first = steps[0]
	const last = steps[steps.length - 1]
	return h.div(
		[h.Class("flex shrink-0 items-baseline justify-between gap-3 pb-2 text-3xs leading-none")],
		[
			legend.length > 0
				? h.div(
						[h.Class("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground")],
						legend.map((entry) =>
							h.span(
								[h.Class("flex min-w-0 items-center gap-1"), h.Title(entry.name)],
								[
									h.span([
										h.Class("size-2 shrink-0 rounded-xs"),
										h.Style({ "background-color": entry.color }),
									]),
									h.span([h.Class("truncate")], [entry.name]),
								],
							),
						),
					)
				: h.span([], []),
			...(first !== undefined && last !== undefined && steps.length > 1
				? [
						h.span(
							[
								h.Class("flex shrink-0 items-baseline gap-1.5 tabular-nums whitespace-nowrap"),
								h.DataAttribute("slot", "funnel-dropoff-summary"),
							],
							[
								h.span([h.Class("text-muted-foreground")], [showPercent ? "Conversion rate" : "Converted"]),
								h.span(
									[h.Class("text-2xs font-semibold text-foreground")],
									[
										showPercent
											? formatPercent(last.ofFirst)
											: `${fmtValue(last.value, unit)} of ${fmtValue(first.value, unit)}`,
									],
								),
							],
						),
					]
				: []),
		],
	)
}

export const view = Submodel.defineView<Model, Message, FunnelChartInputs>((model, inputs, h) => {
	const { steps, legend } = toSteps(inputs.data, pickValueField(inputs.data))
	if (steps.length === 0 || (steps[0]?.value ?? 0) <= 0)
		return h.div(
			[h.Class(cn("relative grid h-full w-full place-items-center", inputs.className))],
			[h.span([h.Class("text-2xs text-muted-foreground")], ["No data"])],
		)
	const width = model.containerWidth
	const isGrouped = legend.length > 0
	const showPercent = inputs.showStepPercent !== false
	const maxSteps =
		width > 0 ? Math.max(1, Math.floor((width + STEP_GAP) / (STEP_MIN_W + STEP_GAP))) : steps.length
	const visible = steps.slice(0, maxSteps)
	const hidden = steps.length - visible.length
	const hover = Option.match(model.activeKey, { onNone: () => null, onSome: Number })
	const hovered = hover !== null && hover > 0 ? visible[hover] : undefined
	const hoveredPrev = hover !== null && hover > 0 ? visible[hover - 1] : undefined
	const columnW = width > 0 ? (width - STEP_GAP * (visible.length - 1)) / visible.length : 0
	const hoverLeft = hover === null ? 0 : hover * (columnW + STEP_GAP)
	const tipLeft =
		hover === null
			? 0
			: hoverLeft + columnW + 8 + TIP_W <= width
				? hoverLeft + columnW + 8
				: Math.max(0, hoverLeft - TIP_W - 8)
	const ctx: ColumnContext = {
		steps,
		visible,
		hover,
		isGrouped,
		showPercent,
		pillTime: columnW === 0 || columnW >= PILL_TIME_MIN_W,
		pillLoss: columnW === 0 || columnW >= PILL_LOSS_MIN_W,
		unit: inputs.unit,
	}
	return h.div(
		[
			h.Class(cn("relative flex h-full w-full flex-col overflow-hidden px-1 select-none", inputs.className)),
			h.OnMount(MeasureChartContainer()),
			h.OnMouseLeave(Message.LeftChart()),
			h.DataAttribute("slot", "funnel-dropoff"),
		],
		[
			header(h, steps, legend, showPercent, inputs.unit),
			h.div(
				[
					h.Class("grid min-h-0 flex-1"),
					h.Style({
						"grid-template-columns": `repeat(${visible.length}, minmax(0, 1fr))`,
						"column-gap": `${STEP_GAP}px`,
					}),
				],
				visible.map((step, index) => column(h, ctx, step, index)),
			),
			...(hidden > 0
				? [h.div([h.Class("shrink-0 pt-1 text-3xs leading-none text-muted-foreground")], [`+${hidden} more`])]
				: []),
			...(hovered !== undefined && hoveredPrev !== undefined && !isGrouped
				? [tooltip(h, hovered, hoveredPrev, tipLeft, inputs.unit)]
				: []),
		],
	)
})
