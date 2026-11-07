import { pickValueField } from "@maple/ui/components/charts/_shared/breakdown-rows"
import { EMPTY_VALUE, formatPercent } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../ui/eyebrow"
import { icon } from "../ui/icon"
import { Message, type Model } from "./chart"
import { MeasureChartContainer } from "./chart-mounts"
import type { FunnelChartInputs } from "./funnel-chart"
import { fmtValue } from "./funnel-chart"
import { fmtSpan, leaverRows, type Step, toSteps } from "./funnel-dropoff-steps"
import { typography, typographyClass } from "../ui/typography"
import { hstack, vstack } from "../ui/stack"
import { swatch } from "../ui/swatch"
import { chartNoData } from "../ui/chart-frame"

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
	hstack(h, { gap: "3", align: "center", justify: "between", className: "py-px tabular-nums" }, [
		hstack(h, { gap: "1.5", as: "span", className: typographyClass({ tone: "muted" }) }, [glyph, label]),
		hstack(h, { gap: "1.5", align: "baseline", as: "span", className: "truncate" }, [
			typography(h, { tone: "foreground", weight: "semibold" }, [value]),
			...(share === undefined ? [] : [h.span([h.Class(cn("text-3xs", shareClass))], [share])]),
		]),
	])

const leaversBlock = (h: H, hovered: Step): ReadonlyArray<Html> =>
	hovered.leavers.length > 0 && hovered.dropped > 0
		? [
				h.div([h.Class("-mx-2.5 my-1.5 h-px bg-border")]),
				eyebrow(h, { as: "div", className: "mb-1 flex items-center gap-1.5" }, [
					icon(h, "ArrowDownIcon", { size: 10, className: TONE_TEXT.crit }),
					"Dropped here went to",
				]),
				...Arr.map(leaverRows(hovered.leavers, hovered.dropped), (entry) =>
					h.div(
						[h.Class("my-0.5")],
						[
							hstack(h, { gap: "2" }, [
								h.span(
									[
										h.Class(
											cn(
												typographyClass({
													truncate: true,
													className: "min-w-0 flex-1",
												}),
												entry.ended
													? "text-muted-foreground"
													: "text-foreground-soft",
											),
										),
									],
									[entry.name],
								),
								typography(h, { tone: "muted", numeric: true }, [formatPercent(entry.share)]),
							]),
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
				"pointer-events-none absolute top-5 z-10 rounded-lg border bg-popover px-2.5 py-2 text-2xs shadow-popup",
			),
			h.Style({ left: `${left}px`, width: `${TIP_W}px` }),
			h.DataAttribute("slot", "funnel-dropoff-tooltip"),
		],
		[
			hstack(
				h,
				{
					gap: "1.5",
					align: "center",
					shrink: true,
					className: "mb-1.5 font-medium text-foreground",
				},
				[
					typography(h, { truncate: true }, [prev.name]),
					icon(h, "ArrowRightIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
					typography(h, { truncate: true }, [hovered.name]),
				],
			),
			hstack(h, { align: "stretch", className: "mb-1.5 h-1.5 gap-px overflow-hidden rounded-sm" }, [
				h.div([h.Class("bg-severity-info"), h.Style({ width: `${(hovered.ofPrev ?? 0) * 100}%` })]),
				h.div([h.Class("flex-1 bg-severity-error/70")]),
			]),
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
	hstack(
		h,
		{ gap: "0.5", align: "end", className: "h-full" },
		Arr.map(step.groups, (group) => {
			const max = ctx.steps[0]?.value ?? 1
			const height = group.value / max
			const capH = Math.max(0, (group.prev - group.value) / max)
			return h.div(
				[
					h.Class("relative h-full flex-1"),
					h.Title(`${group.name} · ${fmtValue(group.value, ctx.unit)}`),
				],
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
	return hstack(
		h,
		{
			gap: "2",
			align: "center",
			as: "span",
			className:
				"absolute bottom-1.5 left-1.5 rounded-md bg-card/95 px-1.5 py-1 text-2xs leading-none tabular-nums whitespace-nowrap shadow-raised ring-1 ring-border-subtle",
			attributes: [h.DataAttribute("slot", "funnel-dropoff-pill")],
		},
		[
			hstack(h, { gap: "1", align: "center", as: "span", className: "font-semibold text-foreground" }, [
				icon(h, isLast ? "CircleCheckIcon" : "ArrowRightIcon", {
					size: 12,
					className: "text-severity-info",
				}),
				formatPercent(step.ofPrev ?? 0),
			]),
			...(ctx.pillLoss && lostShare > 0
				? [
						hstack(
							h,
							{ gap: "1", align: "center", as: "span", className: "text-foreground-soft" },
							[
								icon(h, "ArrowDownIcon", { size: 12, className: TONE_TEXT.crit }),
								formatPercent(lostShare),
							],
						),
					]
				: []),
			...(ctx.pillTime && step.p50Ms !== undefined
				? [
						typography(
							h,
							{ tone: "muted", attributes: [h.Title("Median time from the previous step")] },
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
	return vstack(
		h,
		{
			shrink: true,
			attributes: [
				h.OnMouseEnter(Message.EnteredLegendItem({ key: String(index) })),
				h.DataAttribute("slot", "funnel-dropoff-step"),
			],
		},
		[
			vstack(h, { gap: "1", className: "leading-none" }, [
				h.span(
					[
						h.Class(
							cn(
								"truncate text-2xs font-medium",
								step.unnamed
									? typographyClass({ tone: "muted", className: "italic" })
									: "text-foreground-soft",
							),
						),
						h.Title(step.name),
					],
					[step.name],
				),
				typography(
					h,
					{ size: "base", tone: "foreground", weight: "semibold", numeric: true, truncate: true },
					[ctx.showPercent ? formatPercent(step.ofFirst) : fmtValue(step.value, ctx.unit)],
				),
				typography(h, { size: "2xs", tone: "muted", numeric: true, truncate: true }, [
					ctx.showPercent ? fmtValue(step.value, ctx.unit) : index === 0 ? "entered" : "reached",
				]),
			]),
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

const header = (
	h: H,
	steps: ReadonlyArray<Step>,
	legend: ReadonlyArray<{ name: string; color: string }>,
	showPercent: boolean,
	unit: string | undefined,
): Html => {
	const first = steps[0]
	const last = steps[steps.length - 1]
	return hstack(
		h,
		{ gap: "3", align: "baseline", justify: "between", className: "shrink-0 pb-2 text-3xs leading-none" },
		[
			legend.length > 0
				? hstack(
						h,
						{
							align: "center",
							wrap: true,
							shrink: true,
							className: "gap-x-3 gap-y-0.5 text-muted-foreground",
						},
						Arr.map(legend, (entry) =>
							hstack(
								h,
								{
									gap: "1",
									align: "center",
									shrink: true,
									as: "span",
									attributes: [h.Title(entry.name)],
								},
								[
									swatch(h, { color: entry.color }),
									typography(h, { truncate: true }, [entry.name]),
								],
							),
						),
					)
				: h.span([], []),
			...(first !== undefined && last !== undefined && steps.length > 1
				? [
						hstack(
							h,
							{
								gap: "1.5",
								align: "baseline",
								as: "span",
								className: "shrink-0 tabular-nums whitespace-nowrap",
								attributes: [h.DataAttribute("slot", "funnel-dropoff-summary")],
							},
							[
								typography(h, { tone: "muted" }, [
									showPercent ? "Conversion rate" : "Converted",
								]),
								typography(h, { size: "2xs", tone: "foreground", weight: "semibold" }, [
									showPercent
										? formatPercent(last.ofFirst)
										: `${fmtValue(last.value, unit)} of ${fmtValue(first.value, unit)}`,
								]),
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
		return chartNoData(h, { className: inputs.className })
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
			h.Class(
				cn("relative flex h-full w-full flex-col overflow-hidden px-1 select-none", inputs.className),
			),
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
				Arr.map(visible, (step, index) => column(h, ctx, step, index)),
			),
			...(hidden > 0
				? [
						h.div(
							[h.Class("shrink-0 pt-1 text-3xs leading-none text-muted-foreground")],
							[`+${hidden} more`],
						),
					]
				: []),
			...(hovered !== undefined && hoveredPrev !== undefined && !isGrouped
				? [tooltip(h, hovered, hoveredPrev, tipLeft, inputs.unit)]
				: []),
		],
	)
})
