import { formatNumber, formatPercent, formatValueByUnit } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message, type Model } from "./chart"
import { MeasureChartContainer } from "./chart-mounts"
import { funnelStages, type Stage } from "./funnel-stages"

// Port of `FunnelBarsChart` (packages/ui/src/components/charts/funnel/query-builder-funnel-chart.tsx).
// The hovered stage is `activeKey` (its index), the hovered breakdown group `activeGroup`.
// TODO(funnel-legend): the legend's "+N" chip for chips that wrapped out of its one line.

export interface FunnelChartInputs {
	readonly data: ReadonlyArray<Record<string, unknown>>
	readonly className?: string | undefined
	readonly unit?: string | undefined
	readonly showStepPercent?: boolean | undefined
}

type H = HtmlBuilder<Message>

export const fmtValue = (value: number, unit?: string): string =>
	unit !== undefined && unit !== "" ? formatValueByUnit(value, unit) : formatNumber(value)

const ROW_GAP = 6
const ROW_MIN_H = 22
const ROW_FULL_H = ROW_MIN_H + ROW_GAP
const MORE_ROW_H = 16
const GROUP_BAR_H = 8
export const PERCENT_FLOOR = { floor: 0.0005 }
const LEGEND_H = 18

const sep = (h: H, glyph: string): Html => h.span([h.Class("px-1 text-foreground-faint")], [glyph])

const swatch = (h: H, className: string, color: string): Html =>
	h.span([h.Class(className), h.Style({ "background-color": color })])

const legendRow = (h: H, legend: ReadonlyArray<{ name: string; color: string }>, hoverGroup: string | null): Html =>
	h.div(
		[h.Class("flex shrink-0 items-start gap-x-3 text-3xs leading-none text-muted-foreground")],
		[
			h.div(
				[
					h.Class(
						"relative flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 overflow-hidden",
					),
					h.Style({ "max-height": `${LEGEND_H}px` }),
					h.DataAttribute("slot", "funnel-legend"),
				],
				legend.map((entry) =>
					h.button(
						[
							h.Type("button"),
							h.Class(
								cn(
									"flex min-w-0 items-center gap-1 transition-opacity",
									hoverGroup !== null && hoverGroup !== entry.name && "opacity-50",
								),
							),
							h.OnMouseEnter(Message.ChangedActiveGroup({ maybeGroup: Option.some(entry.name) })),
							h.OnMouseLeave(Message.ChangedActiveGroup({ maybeGroup: Option.none() })),
							h.Title(entry.name),
						],
						[
							swatch(h, "size-2 shrink-0 rounded-xs", entry.color),
							h.span([h.Class("truncate")], [entry.name]),
						],
					),
				),
			),
		],
	)

type Flags = Readonly<{ unit: string | undefined; showShareOfFirst: boolean; showStepConversion: boolean }>

const stageNumbers = (h: H, stage: Stage, hoverGroup: string | null, flags: Flags): ReadonlyArray<Html> => {
	const hovered = hoverGroup === null ? undefined : stage.groups.find((group) => group.name === hoverGroup)
	if (hovered !== undefined)
		return [
			swatch(h, "mr-1 inline-block size-2 rounded-xs align-middle", hovered.color),
			h.span([h.Class("text-foreground-soft")], [fmtValue(hovered.value, flags.unit)]),
			...(flags.showShareOfFirst
				? [sep(h, "·"), h.span([], [formatPercent(hovered.pctOfFirst, PERCENT_FLOOR)])]
				: []),
		]
	return [
		h.span([h.Class("text-foreground-soft")], [fmtValue(stage.value, flags.unit)]),
		...(flags.showShareOfFirst
			? [sep(h, "·"), h.span([], [formatPercent(stage.pctOfFirst, PERCENT_FLOOR)])]
			: []),
		...(flags.showStepConversion && stage.pctOfPrev !== null
			? [sep(h, "↓"), h.span([], [formatPercent(stage.pctOfPrev, PERCENT_FLOOR)])]
			: []),
	]
}

const groupBars = (h: H, stage: Stage, hoverGroup: string | null, fade: number, unit: string | undefined): Html =>
	h.div(
		[h.Class("flex w-full flex-col gap-0.5"), h.DataAttribute("slot", "funnel-group-bars")],
		stage.groups.map((group) =>
			h.div(
				[
					h.Class("relative h-1.5 w-full overflow-hidden rounded-xs bg-foreground/5"),
					h.OnMouseEnter(Message.ChangedActiveGroup({ maybeGroup: Option.some(group.name) })),
					h.OnMouseLeave(Message.ChangedActiveGroup({ maybeGroup: Option.none() })),
					h.Title(`${group.name} · ${fmtValue(group.value, unit)}`),
				],
				[
					h.div([
						h.Class("absolute inset-y-0 left-0 rounded-xs"),
						h.Style({
							width: `${group.widthPct * 100}%`,
							"background-color": group.color,
							opacity: String((hoverGroup !== null && hoverGroup !== group.name ? 0.35 : 1) * fade),
							transition: "opacity 140ms ease, width 220ms ease",
						}),
					]),
				],
			),
		),
	)

export const view = Submodel.defineView<Model, Message, FunnelChartInputs>((model, inputs, h) => {
	const { stages, legend } = funnelStages(inputs.data)
	if (stages.length === 0)
		return h.div(
			[h.Class(cn("relative h-full w-full grid place-items-center", inputs.className))],
			[h.span([h.Class("text-2xs text-muted-foreground")], ["No data"])],
		)
	const isGrouped = legend.length > 0
	const rowFullH = isGrouped ? ROW_MIN_H + legend.length * GROUP_BAR_H + ROW_GAP : ROW_FULL_H
	const chromeH = MORE_ROW_H + (isGrouped ? LEGEND_H : 0)
	const height = model.containerHeight
	const maxRows = height > 0 ? Math.max(1, Math.floor((height - chromeH) / rowFullH)) : stages.length
	const truncated = stages.length > maxRows
	const visible = truncated ? stages.slice(0, maxRows) : stages
	const hiddenCount = stages.length - visible.length
	const hover = Option.getOrNull(model.activeKey)
	const hoverGroup = Option.getOrNull(model.activeGroup)
	const flags: Flags = {
		unit: inputs.unit,
		showShareOfFirst: inputs.showStepPercent !== false,
		showStepConversion: inputs.showStepPercent === true,
	}
	return h.div(
		[
			h.Class(
				cn(
					"flex h-full w-full flex-col gap-1.5 overflow-hidden px-1 select-none",
					truncated ? "justify-start" : "justify-center",
					inputs.className,
				),
			),
			h.Style({ "row-gap": `${ROW_GAP}px` }),
			h.OnMount(MeasureChartContainer()),
			h.OnMouseLeave(Message.LeftChart()),
		],
		[
			...(isGrouped ? [legendRow(h, legend, hoverGroup)] : []),
			...visible.map((stage, i) => {
				const key = String(i)
				const fade = hover !== null && hover !== key ? 0.55 : 1
				return h.div(
					[
						h.Class("flex min-h-0 flex-col justify-center gap-0.5"),
						h.Style({ "min-height": `${ROW_MIN_H}px` }),
						h.OnMouseEnter(Message.EnteredLegendItem({ key })),
					],
					[
						h.div(
							[h.Class("flex items-baseline justify-between gap-2 text-2xs leading-none")],
							[
								h.span(
									[
										h.Class(
											cn(
												"truncate",
												stage.unnamed ? "italic text-muted-foreground" : "text-foreground-soft",
											),
										),
										h.Title(stage.name),
									],
									[stage.name],
								),
								h.span(
									[h.Class("shrink-0 tabular-nums text-muted-foreground")],
									stageNumbers(h, stage, hoverGroup, flags),
								),
							],
						),
						isGrouped ? groupBars(h, stage, hoverGroup, fade, inputs.unit) : stageBar(h, stage, fade),
					],
				)
			}),
			...(hiddenCount > 0
				? [h.div([h.Class("shrink-0 text-3xs leading-none text-muted-foreground")], [`+${hiddenCount} more`])]
				: []),
		],
	)
})

const stageBar = (h: H, stage: Stage, fade: number): Html =>
	h.div(
		[h.Class("relative h-2.5 w-full overflow-hidden rounded-[3px] bg-foreground/5")],
		[
			h.div([
				h.Class("absolute inset-y-0 left-0 rounded-[3px]"),
				h.Style({
					width: `${stage.widthPct * 100}%`,
					"background-color": stage.color,
					opacity: String(fade),
					transition: "opacity 140ms ease, width 220ms ease",
				}),
			]),
		],
	)
