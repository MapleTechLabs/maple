import * as BarChart from "@maple/views/charts/bar-chart"
import * as Chart from "@maple/views/charts/chart"
import { ResolveThemeColors, ThemeColors } from "@maple/views/charts/theme-colors"
import { currencyUnit, formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { delta } from "@maple/views/ui/delta"
import { activeFilterChips } from "@maple/views/ui/filters/active-filter-chips"
import { icon } from "@maple/views/ui/icon"
import { panel, panelChartBody, panelHeader, panelTitle } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statFigure } from "@maple/views/ui/stat-figure"
import { swatch } from "@maple/views/ui/swatch"
import {
	ariaSort,
	numericTableCell,
	sortButton,
	table,
	tableBody,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
} from "@maple/views/ui/table"
import { tableRowLinkStyles } from "@maple/views/ui/table.styles"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { Command, Dom, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../../foldkit-island/island"
import {
	type BreakdownRow,
	type CostView,
	costView,
	CURRENCY,
	DAYS,
	DIMENSION_TEXT,
	DIMENSIONS,
	drillTarget,
	ESTIMATED_DAYS,
	formatMoney,
	formatMoneyChange,
	keyLabel,
	keyMark,
	NOW_MS,
} from "./live-cost-data"

// The dashboard's Cost page over invented spend, drawn by the `@maple/views` kit and the bar
// chart's own definition (the `bar` host). A row's click narrows the page and regroups it.

const CHART_ID = "landing-cost-daily"
const CHART_HEIGHT = 280

// MODEL

const Dimension = Schema.Literals(DIMENSIONS)
const Filter = Schema.Struct({ dimension: Dimension, value: Schema.String })
const SortBy = Schema.Literals(["cost", "change"])

const Model = Schema.Struct({
	groupBy: Dimension,
	filters: Schema.Array(Filter),
	sort: SortBy,
	chart: Chart.Model,
	/** Read off the page once the island runs; the server renders the static preview. */
	themeColors: Schema.Option(ThemeColors),
	/** The chart has drawn; until then the static preview holds the box. */
	isChartDrawn: Schema.Boolean,
})
type Model = typeof Model.Type

// MESSAGE

const Message = defineMessageUnion({
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { message: Chart.Message },
	PickedGroupBy: { groupBy: Dimension },
	ClickedRow: { filter: Filter },
	ClickedRemoveFilter: { filter: Filter },
	ClickedClearFilters: {},
	ClickedSort: { sort: SortBy },
	CompletedFocusRow: {},
})
type Message = typeof Message.Type

const BREAKDOWN_ID = "landing-cost-breakdown"

const GROUP_BY_ID = "landing-cost-group-by"

/** A row's click replaces the row that held focus: it moves on to a control that is still there. */
const GROUPING = `#${GROUP_BY_ID} [aria-pressed="true"]`

const FocusAfterDrill = Command.define("FocusAfterDrill", {
	args: { selector: Schema.String },
	messages: [Message.CompletedFocusRow],
	execute: ({ selector }) =>
		Dom.focus(selector).pipe(Effect.ignore, Effect.as(Message.CompletedFocusRow())),
})

type H = HtmlBuilder<Message>

// UPDATE

const hasFilter = (model: Model, filter: typeof Filter.Type): boolean =>
	Arr.some(model.filters, (entry) => entry.dimension === filter.dimension && entry.value === filter.value)

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: Option.some(colors) } }),
		GotChartMessage: ({ message: inner }) => ({
			model: {
				...model,
				chart: Chart.update(model.chart, inner).model,
				isChartDrawn: model.isChartDrawn || inner._tag === "CompletedMountChart",
			},
		}),
		PickedGroupBy: ({ groupBy }) => ({ model: { ...model, groupBy } }),
		// A row's click: the page narrowed to the row's key, then split by the next dimension.
		ClickedRow: ({ filter }) => {
			if (hasFilter(model, filter)) return { model }
			const filters = [...model.filters, filter]
			const groupBy = drillTarget(filter.dimension, filters)
			// Regrouped, every new row can be clicked. On the last level the one row left is plain
			// text, so focus goes to the grouping in effect.
			const selector = groupBy === filter.dimension ? GROUPING : `#${BREAKDOWN_ID} tbody button`
			return { model: { ...model, filters, groupBy }, commands: [FocusAfterDrill({ selector })] }
		},
		// The removed chip held focus, and so did Clear all: it moves to the grouping in effect.
		ClickedRemoveFilter: ({ filter }) => ({
			model: {
				...model,
				filters: Arr.filter(
					model.filters,
					(entry) => entry.dimension !== filter.dimension || entry.value !== filter.value,
				),
			},
			commands: [FocusAfterDrill({ selector: GROUPING })],
		}),
		ClickedClearFilters: () => ({
			model: { ...model, filters: [] },
			commands: [FocusAfterDrill({ selector: GROUPING })],
		}),
		ClickedSort: ({ sort }) => ({ model: { ...model, sort } }),
		CompletedFocusRow: () => ({ model }),
	})

// VIEW

const tile = (h: H, children: ReadonlyArray<Html>): Html => h.div([h.Class("min-w-0 px-5 py-4")], children)

/** The row of figures: cost in the window, the change against the period before, the daily average. */
const figures = (h: H, data: CostView): Html =>
	h.div(
		[
			h.Class(
				"grid grid-cols-1 divide-y divide-border rounded-md border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0",
			),
		],
		[
			tile(h, [
				statFigure(h, {
					label: "Cost",
					value: formatMoney(data.cost),
					caption: `Over ${DAYS} days`,
					size: "md",
				}),
			]),
			tile(h, [
				statFigure(h, {
					label: "Change",
					value: formatMoneyChange(data.cost - data.previousCost),
					caption: hstack(h, { gap: "1.5", as: "span", inline: true }, [
						// Rising cost is not good news: the delta reads it as the worse direction.
						delta(h, { current: data.cost, previous: data.previousCost, invert: true }),
						`against the ${DAYS} days before`,
					]),
					size: "md",
				}),
			]),
			tile(h, [
				statFigure(h, {
					label: "Average per day",
					value: formatMoney(data.cost / DAYS),
					caption: "Per UTC day",
					size: "md",
				}),
			]),
		],
	)

/** Group by on the left, the filters in effect beside it. */
const toolbar = (h: H, model: Model): Html => {
	const chips = activeFilterChips(h, {
		chips: Arr.map(model.filters, (filter) => ({
			id: `${filter.dimension}:${filter.value}`,
			label: DIMENSION_TEXT[filter.dimension].label,
			values: [keyLabel(filter.dimension, filter.value)],
			mark: keyMark(filter.dimension, filter.value),
			onRemove: Message.ClickedRemoveFilter({ filter }),
		})),
		onClearAll: Message.ClickedClearFilters(),
		className: "mb-0 min-w-0 max-w-full",
	})
	return hstack(h, { gap: "4", wrap: true, className: "gap-y-2" }, [
		hstack(h, { gap: "2", className: "min-w-0 max-w-full", attributes: [h.Id(GROUP_BY_ID)] }, [
			// On a phone the four options need the row: the control carries the name itself.
			typography(h, { size: "xs", tone: "muted", className: "shrink-0 max-sm:sr-only" }, ["Group by"]),
			segmentedSelect(h, {
				ariaLabel: "Group by",
				size: "sm",
				className: "min-w-0 overflow-x-auto max-sm:[&_[data-slot=toggle]]:px-2",
				value: model.groupBy,
				options: Arr.map(DIMENSIONS, (dimension) => ({
					value: dimension,
					label: DIMENSION_TEXT[dimension].label,
				})),
				onChange: (groupBy) => Message.PickedGroupBy({ groupBy }),
			}),
		]),
		...(chips === null ? [] : [chips]),
	])
}

/**
 * The window's days as plain stacked columns, inset like the chart's plot area: what the server
 * renders and what shows until the chart has drawn over it.
 */
const preview = (h: H, data: CostView): Html => {
	const totals = Arr.map(data.chartRows, (row) =>
		Arr.reduce(data.seriesColors, 0, (sum, [name]) => {
			const point = row[name]
			return sum + (typeof point === "number" ? point : 0)
		}),
	)
	const max = Math.max(1, ...totals)
	return h.div(
		[h.AriaHidden(true), h.Class("absolute inset-0 flex items-end gap-1 pt-2 pb-14 pl-12 pr-1")],
		Arr.map(data.chartRows, (row) =>
			h.div(
				[
					h.Key(String(row.bucket)),
					h.Class(
						cn(
							"flex h-full min-w-0 flex-1 flex-col-reverse",
							row.partial === true && "opacity-50",
						),
					),
				],
				Arr.map(data.seriesColors, ([name, color]) => {
					const point = row[name]
					return h.div([
						h.Style({
							height: `${((typeof point === "number" ? point : 0) / max) * 100}%`,
							"background-color": color,
						}),
					])
				}),
			),
		),
	)
}

const plot = (h: H, model: Model, data: CostView): ReadonlyArray<Html> =>
	Option.match(model.themeColors, {
		onNone: () => [],
		onSome: (theme) => [
			h.submodel({
				slotId: CHART_ID,
				model: model.chart,
				view: BarChart.view,
				viewInputs: {
					chartId: CHART_ID,
					host: "bar",
					data: data.chartRows,
					seriesMarks: data.seriesMarks,
					theme,
					unit: currencyUnit(CURRENCY),
					// Cost days are UTC calendar days, whatever the viewer's zone.
					timeZone: "UTC",
					nowMs: NOW_MS,
					stacked: true,
					legend: "visible",
				},
				toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ message }),
			}),
		],
	})

/** Stacked bars per UTC day, one series per key of the grouping, the tail folded into "Other". */
const dailyChart = (h: H, model: Model, data: CostView): Html =>
	panel(h, {}, [
		panelHeader(h, {
			divided: false,
			className: "px-3 pt-2.5",
			children: [
				vstack(h, { gap: "0.5", shrink: true }, [
					panelTitle(h, [`Daily cost by ${DIMENSION_TEXT[model.groupBy].noun}`]),
					typography(h, { size: "2xs", tone: "subtle", as: "p" }, [
						`${CURRENCY} per UTC day. The last ${ESTIMATED_DAYS} days are lighter: the provider can still restate them.`,
					]),
				]),
			],
		}),
		panelChartBody(h, [
			h.div(
				[
					h.Class("relative w-full"),
					h.Style({ height: `${CHART_HEIGHT}px` }),
					h.OnMount(ResolveThemeColors({ tokens: BarChart.BAR_CHART_TOKENS })),
				],
				[...(model.isChartDrawn ? [] : [preview(h, data)]), ...plot(h, model, data)],
			),
		]),
	])

/** The first and last columns line up with the panel header's inset. */
const FIRST = "in-data-[size=sm]:pl-4"
const LAST = "in-data-[size=sm]:pr-4"
/** Share and the period before drop out on a phone; cost and its change stay. */
const ROOMY = "hidden sm:table-cell"

const head = (h: H, model: Model): Html => {
	const sortable = (key: typeof SortBy.Type, label: string, className?: string) =>
		tableHead(
			h,
			[
				sortButton(
					h,
					{
						isActive: model.sort === key,
						direction: "desc",
						align: "right",
						onClick: Message.ClickedSort({ sort: key }),
					},
					[label],
				),
			],
			cn("text-right", className),
			ariaSort(h, model.sort === key, "desc"),
		)
	return tableHeader(h, [
		tableRow(h, [
			tableHead(h, [DIMENSION_TEXT[model.groupBy].label], FIRST),
			sortable("cost", "Cost"),
			tableHead(h, ["Share"], cn("text-right", ROOMY)),
			tableHead(h, ["Previous period"], cn("text-right", ROOMY)),
			sortable("change", "Change", LAST),
		]),
	])
}

const row = (h: H, model: Model, data: CostView, entry: BreakdownRow): Html => {
	const filter = { dimension: model.groupBy, value: entry.key }
	const next = drillTarget(model.groupBy, [...model.filters, filter])
	const name = hstack(h, { gap: "2", shrink: true }, [
		icon(h, entry.mark.icon, { size: 14, className: cn("shrink-0", entry.mark.className) }),
		truncatedText(h, { text: entry.label, className: "text-xs" }),
	])
	return tableRow(
		h,
		[
			truncatedTableCell(
				h,
				[
					hstack(h, { gap: "2", shrink: true }, [
						entry.color === undefined
							? swatch(h, { className: "bg-transparent" })
							: swatch(h, { color: entry.color }),
						// A row already filtered to has nothing to add: its name is plain text.
						hasFilter(model, filter)
							? name
							: pressable(
									h,
									{
										onClick: Message.ClickedRow({ filter }),
										// The row link draws the ring over the whole row; the button's own is dropped.
										className: cn(
											tableRowLinkStyles,
											"block min-w-0 text-left focus-visible:ring-0",
										),
										attributes: [
											h.Title(
												next === model.groupBy
													? `Filter to ${DIMENSION_TEXT[model.groupBy].label}: ${entry.label}`
													: `${entry.label} by ${DIMENSION_TEXT[next].noun}`,
											),
										],
									},
									[name],
								),
					]),
				],
				cn("min-w-32", FIRST),
			),
			numericTableCell(h, [formatMoney(entry.cost)]),
			numericTableCell(h, [formatPercent(entry.cost / data.cost, { floor: 0.001 })], ROOMY),
			numericTableCell(h, [typography(h, { tone: "muted" }, [formatMoney(entry.previousCost)])], ROOMY),
			numericTableCell(
				h,
				[
					hstack(h, { gap: "2", justify: "end" }, [
						typography(h, { className: "hidden md:inline" }, [
							formatMoneyChange(entry.cost - entry.previousCost),
						]),
						delta(h, {
							current: entry.cost,
							previous: entry.previousCost,
							invert: true,
							className: "w-16 justify-end",
						}),
					]),
				],
				LAST,
			),
		],
		undefined,
		[h.Key(entry.key)],
	)
}

/** The window's cost per key of the grouping; a row's name narrows the page to it. */
const breakdown = (h: H, model: Model, data: CostView): Html =>
	panel(h, { attributes: [h.Id(BREAKDOWN_ID)] }, [
		panelHeader(h, {
			title: `Cost by ${DIMENSION_TEXT[model.groupBy].noun}`,
			// On the last level the one row left is not a control, and the hint would point at nothing.
			...(Arr.some(
				data.rows,
				(entry) => !hasFilter(model, { dimension: model.groupBy, value: entry.key }),
			)
				? {
						action: typography(h, { size: "2xs", tone: "subtle" }, [
							"Select a row to break it down",
						]),
					}
				: undefined),
		}),
		table(h, { size: "sm", ariaLabel: `Cost by ${DIMENSION_TEXT[model.groupBy].noun}` }, [
			head(h, model),
			tableBody(
				h,
				Arr.map(data.rows, (entry) => row(h, model, data, entry)),
			),
		]),
	])

const view = (model: Model, h: H): Html => {
	const data = costView(model.groupBy, model.filters, model.sort)
	return h.div(
		[h.Class("live-frame")],
		[
			h.div(
				[h.Class("live-frame__head")],
				[
					h.span([], [`/cost · last ${DAYS} days`]),
					h.span(
						[h.Class("live-frame__live")],
						[h.span([h.Class("live-frame__live-dot")], []), "DEMO"],
					),
				],
			),
			// The frame is set in mono for its head; the page inside reads in the product's face.
			h.div(
				[h.Class("grid grid-cols-1 gap-4 bg-background p-3 font-sans text-foreground sm:p-5")],
				[figures(h, data), toolbar(h, model), dailyChart(h, model, data), breakdown(h, model, data)],
			),
		],
	)
}

const INITIAL: Model = {
	groupBy: "provider",
	filters: [],
	sort: "cost",
	chart: Chart.init(),
	themeColors: Option.none(),
	isChartDrawn: false,
}

export const LiveCostExplorer = makeIsland({
	name: "live-cost-explorer",
	Props: Schema.Struct({}),
	Model,
	init: () => ({ model: INITIAL }),
	update,
	view,
})
