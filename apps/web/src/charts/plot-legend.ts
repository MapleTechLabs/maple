import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "./chart"

// Port of `PlotLegend` and `PlotStatsLegend` (packages/ui/src/components/plot/plot-legend.tsx).
// Hover and click are Chart Messages; `active` and `highlighted` come from the chart Model.

export interface PlotLegendSeries {
	readonly key: string
	readonly label: string
	readonly color: string
	readonly dashed?: boolean
	readonly value?: string | undefined
	readonly secondary?: string | undefined
}

export interface PlotLegendState {
	readonly series: ReadonlyArray<PlotLegendSeries>
	readonly highlighted: Option.Option<string>
	readonly active: Option.Option<string>
	readonly label: string
}

const swatch = (h: HtmlBuilder<Message>, color: string, dashed: boolean | undefined): Html =>
	h.span([
		h.Class(cn("size-2 shrink-0 rounded-xs", dashed && "border border-dashed")),
		h.Style(dashed ? { "border-color": color } : { "background-color": color }),
	])

const legendValue = (h: HtmlBuilder<Message>, value: string, secondary: string | undefined): Html =>
	h.span(
		[h.Class("ml-auto flex shrink-0 items-baseline gap-2 font-mono tabular-nums")],
		[
			h.span([h.Class("text-foreground")], [value]),
			...(secondary === undefined
				? []
				: [h.span([h.Class("w-11 text-right text-muted-foreground")], [secondary])]),
		],
	)

const isKey = (maybeKey: Option.Option<string>, key: string): boolean =>
	Option.isSome(maybeKey) && maybeKey.value === key

/** `PlotLegendItem` without a hide toggle (no chart in the gallery passes `onToggle`). */
const legendItem = (h: HtmlBuilder<Message>, state: PlotLegendState, entry: PlotLegendSeries): Html => {
	const isHighlighted = isKey(state.highlighted, entry.key)
	const hovering = Option.isSome(state.active)
	const isActive = isKey(state.active, entry.key)
	const isMuted = hovering ? !isActive : Option.isSome(state.highlighted) && !isHighlighted
	return h.keyed("button")(
		entry.key,
		[
			h.Type("button"),
			h.AriaPressed(String(isHighlighted)),
			h.OnClick(Message.ClickedLegendItem({ key: entry.key })),
			h.OnMouseEnter(Message.EnteredLegendItem({ key: entry.key })),
			h.OnFocus(Message.EnteredLegendItem({ key: entry.key })),
			h.Class(
				cn(
					// Labels sit one step under the card title; the focused series reads full strength.
					"flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-muted-foreground transition-colors hover:bg-surface-sunken hover:text-foreground",
					isMuted && "opacity-40",
					(isActive || (!hovering && isHighlighted)) && "bg-surface-sunken text-foreground",
				),
			),
		],
		[
			swatch(h, entry.color, entry.dashed),
			h.span([h.Class("truncate")], [entry.label]),
			...(entry.value === undefined ? [] : [legendValue(h, entry.value, entry.secondary)]),
		],
	)
}

const items = (h: HtmlBuilder<Message>, state: PlotLegendState): ReadonlyArray<Html> =>
	state.series.map((entry) => legendItem(h, state, entry))

/** `PlotLegend.Row` + `Items`. */
export const legendRow = (h: HtmlBuilder<Message>, state: PlotLegendState, className?: string): Html =>
	h.div(
		[
			h.AriaLabel(state.label),
			h.OnPointerLeave(() => Option.some(Message.LeftLegend())),
			h.Class(cn("flex flex-wrap gap-x-3 gap-y-0.5 pt-2 text-xs select-none", className)),
		],
		items(h, state),
	)

/** `PlotLegend.Column` + `Items`. */
export const legendColumn = (h: HtmlBuilder<Message>, state: PlotLegendState, className?: string): Html =>
	h.div(
		[
			h.AriaLabel(state.label),
			h.OnPointerLeave(() => Option.some(Message.LeftLegend())),
			h.Class(cn("flex flex-col gap-0.5 pl-3 text-xs select-none", className)),
		],
		items(h, state),
	)

/** `PlotStatsLegend`: the column with value and share figures, or nothing for no series. */
export const statsLegend = (h: HtmlBuilder<Message>, state: PlotLegendState): Option.Option<Html> =>
	state.series.length === 0 ? Option.none() : Option.some(legendColumn(h, state, "pl-0"))
