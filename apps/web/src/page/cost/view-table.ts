import type { CostBreakdownResponse, CostBreakdownRow, CostBreakdownSortBy } from "@maple/domain/http"
import { EMPTY_VALUE, formatPercent } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { delta } from "@maple/views/ui/delta"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { hstack } from "@maple/views/ui/stack"
import { swatch } from "@maple/views/ui/swatch"
import {
	ariaSort,
	numericTableCell,
	rowLink,
	sortButton,
	table,
	tableBody,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
} from "@maple/views/ui/table"
import { tableSkeleton } from "@maple/views/ui/table-skeleton"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography } from "@maple/views/ui/typography"
import {
	DIMENSIONS,
	formatMoney,
	formatMoneyChange,
	groupByOf,
	hasFilter,
	previousPeriodOf,
	keyLabel,
	seriesLabels,
	sortOf,
	type CostGroupBy,
	withFilter,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

/** The first and last columns line up with the panel header's inset. */
const FIRST = "in-data-[size=sm]:pl-4"
const LAST = "in-data-[size=sm]:pr-4"

const COLUMNS = ["Cost", "Share", "Previous period", "Change"] as const

const head = (h: H, dimension: CostGroupBy, sort: CostBreakdownSortBy): Html => {
	const sortable = (key: CostBreakdownSortBy, label: string, className?: string) =>
		tableHead(
			h,
			[
				sortButton(
					h,
					{
						isActive: sort === key,
						direction: "desc",
						align: "right",
						onClick: Message.ClickedSort({ sort: key }),
					},
					[label],
				),
			],
			`text-right ${className ?? ""}`,
			ariaSort(h, sort === key, "desc"),
		)
	return tableHeader(h, [
		tableRow(h, [
			tableHead(h, [DIMENSIONS[dimension].label], FIRST),
			sortable("cost", "Cost"),
			tableHead(h, ["Share"], "text-right"),
			tableHead(h, ["Previous period"], "text-right"),
			sortable("change", "Change", LAST),
		]),
	])
}

/** The chart's colour of each key it draws on its own, so a row reads against its bars. */
const seriesColors = (model: Model, dimension: CostGroupBy): ReadonlyMap<string, string> => {
	const series = Option.getOrUndefined(AsyncData.getData(model.timeseries.data))?.series ?? []
	// The same name set the bar chart resolves, "Other" included: a colour depends on the whole set.
	const labels = seriesLabels(dimension, series)
	const colors = resolveSeriesColors(labels)
	return new Map(
		Arr.flatMap(series, (entry, index) => {
			const color = colors.get(labels[index] ?? entry.key)
			return entry.other || color === undefined ? [] : [[entry.key, color] as const]
		}),
	)
}

const row = (
	h: H,
	model: Model,
	dimension: CostGroupBy,
	entry: CostBreakdownRow,
	colors: ReadonlyMap<string, string>,
	// The breakdown's own: the rows keep their currency when the totals read failed.
	currency: string,
): Html => {
	const totals = Option.getOrUndefined(AsyncData.getData(model.totals.data))
	// A period a source lacks history for is too cheap to compare with; the totals carry the
	// window's days, so nothing is compared until they answer.
	const previousSynced =
		totals !== undefined &&
		previousPeriodOf(
			Option.match(AsyncData.getData(model.sources.data), {
				onNone: () => [],
				onSome: (response) => response.sources,
			}),
			model.window,
			totals.days,
		) === "synced"
	const label = keyLabel(dimension, entry.key)
	const filter = { dimension, value: entry.key }
	const color = colors.get(entry.key)
	const name = truncatedText(h, { text: label, className: "text-xs" })
	return tableRow(
		h,
		[
			truncatedTableCell(
				h,
				[
					hstack(h, { gap: "2", shrink: true }, [
						color === undefined
							? swatch(h, { className: "bg-transparent" })
							: swatch(h, { color }),
						// A row already filtered to has nothing to add: its name is plain text.
						hasFilter(model.search, filter)
							? name
							: rowLink(
									h,
									{
										href: hrefOf(
											AppRoute.Cost({ search: withFilter(model.search, filter) }),
										),
										className: "block min-w-0",
										attributes: [
											h.Title(`Filter to ${DIMENSIONS[dimension].label}: ${label}`),
										],
									},
									[name],
								),
					]),
				],
				`min-w-48 ${FIRST}`,
			),
			numericTableCell(h, [formatMoney(entry.cost, currency)]),
			numericTableCell(h, [
				totals !== undefined && totals.cost > 0
					? formatPercent(entry.cost / totals.cost, { floor: 0.001 })
					: EMPTY_VALUE,
			]),
			numericTableCell(h, [
				typography(h, { tone: "muted" }, [
					previousSynced ? formatMoney(entry.previousCost, currency) : EMPTY_VALUE,
				]),
			]),
			numericTableCell(
				h,
				previousSynced
					? [
							hstack(h, { gap: "2", justify: "end" }, [
								formatMoneyChange(entry.cost - entry.previousCost, currency),
								delta(h, {
									current: entry.cost,
									previous: entry.previousCost,
									invert: true,
									className: "w-16 justify-end",
								}),
							]),
						]
					: [EMPTY_VALUE],
				LAST,
			),
		],
		undefined,
		[h.Key(entry.key)],
	)
}

const rowsTable = (h: H, model: Model, response: CostBreakdownResponse, isStale: boolean): Html => {
	const dimension = groupByOf(model.search)
	const colors = seriesColors(model, dimension)
	return table(
		h,
		{
			size: "sm",
			ariaLabel: `Cost by ${DIMENSIONS[dimension].noun}`,
			className: refreshingClass(isStale),
		},
		[
			head(h, dimension, sortOf(model.search)),
			tableBody(
				h,
				Arr.map(response.rows, (entry) => row(h, model, dimension, entry, colors, response.currency)),
			),
		],
	)
}

const loading = (h: H, dimension: CostGroupBy): Html =>
	tableSkeleton(h, {
		columns: [
			{
				header: DIMENSIONS[dimension].label,
				skeleton: "w-40",
				headClassName: FIRST,
				cellClassName: FIRST,
			},
			...Arr.map(COLUMNS, (header) => ({
				header,
				skeleton: "ml-auto w-16",
				headClassName: "text-right",
			})),
		],
		rows: 8,
	})

/** The window's cost per key of the grouping; a row's name filters the page to it. */
export const breakdownTable = (h: H, model: Model): Html => {
	const dimension = groupByOf(model.search)
	return panel(h, {}, [
		panelHeader(h, {
			title: `Cost by ${DIMENSIONS[dimension].noun}`,
			action: typography(h, { size: "2xs", tone: "subtle" }, ["Select a row to filter to it"]),
		}),
		AsyncData.matchData(model.breakdown.data, {
			onEmpty: () => loading(h, dimension),
			onFailure: (failure) =>
				errorState(h, {
					failure,
					title: "Couldn't load the cost breakdown",
					onRetry: Message.ClickedRetry(),
				}),
			onData: (response) =>
				response.rows.length === 0
					? emptyMessage(h, { className: "py-10" }, ["No cost in this window"])
					: rowsTable(h, model, response, AsyncData.isRefreshing(model.breakdown.data)),
		}),
	])
}
