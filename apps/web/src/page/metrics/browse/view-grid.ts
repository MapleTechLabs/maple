import { validateCssColor } from "@maple/ui/lib/sanitizers"
import { Option } from "effect"
import { AsyncData as FoldkitAsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import * as Sparkline from "../../../charts/sparkline"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { cardButton } from "../../../ui/card-button"
import { badge } from "../../../ui/display"
import { listFooter } from "../../../ui/list-footer"
import { skeletonList } from "../../../ui/skeleton"
import { truncatedText } from "../../../ui/truncated-text"
import { METRIC_TYPE_COLORS, metricTypeBadge, SPARKLINE_METRIC_TYPES } from "../shared"
import {
	entryKey,
	gridPages,
	namesOfType,
	PAGE_SIZE,
	type PreviewEntry,
	sparklineRequest,
	sparklineValues,
	toEntries,
} from "./derive"
import { Message } from "./message"
import type { Model, SparklinePoint } from "./model"

// The metric preview grid and its cards.

type H = HtmlBuilder<Message>

const GRID_CLASS = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"

/** Sparklines keep no interaction state; one constant Model satisfies the frame. */
const CHART_MODEL = Chart.init()
const toSparklineMessage = (message: Chart.Message) => Message.GotSparklineMessage({ message })

export const loadingGrid = (h: H): Html =>
	skeletonList(h, { rows: 8, rowClassName: "h-32", className: GRID_CLASS })

type PageSparklines = Readonly<{
	pointsByMetric: ReadonlyMap<string, ReadonlyArray<SparklinePoint>>
	isLoading: boolean
	failedTypes: ReadonlySet<string>
}>

/** `usePageSparklines`: one query per metric type on the page, folded into points by metric. */
const pageSparklines = (
	model: Model,
	orgId: string,
	entries: ReadonlyArray<PreviewEntry>,
): PageSparklines => {
	const { window } = model
	const types = SPARKLINE_METRIC_TYPES.filter((type) => namesOfType(entries, type).length > 0)
	const slots = types.map(
		(type) =>
			[
				type,
				window === null
					? undefined
					: model.sparklines[sparklineRequest(orgId, window, type, namesOfType(entries, type)).key],
			] as const,
	)
	return {
		pointsByMetric: new Map(
			slots.flatMap(([type, slot]) =>
				slot === undefined
					? []
					: Option.getOrElse(FoldkitAsyncData.getData(slot.data), () => []).map(
							(series) => [entryKey(series.metricName, type), series.points] as const,
						),
			),
		),
		isLoading: slots.some(
			([, slot]) =>
				slot === undefined ||
				FoldkitAsyncData.isIdle(slot.data) ||
				FoldkitAsyncData.isLoading(slot.data),
		),
		failedTypes: new Set(
			slots.flatMap(([type, slot]) =>
				slot !== undefined && FoldkitAsyncData.isFailure(slot.data) ? [type] : [],
			),
		),
	}
}

const finiteOrZero = (value: number) => (Number.isFinite(value) ? value : 0)

const sparkline = (h: H, theme: ThemeColors, entry: PreviewEntry, values: ReadonlyArray<number>): Html => {
	const token =
		validateCssColor(METRIC_TYPE_COLORS.get(entry.metricType) ?? "var(--chart-1)") ?? "var(--chart-1)"
	const slotId = `metric-spark-${entryKey(entry.metricName, entry.metricType)}`
	return h.div(
		[h.Class("h-full w-full")],
		[
			h.submodel({
				slotId,
				model: CHART_MODEL,
				view: Sparkline.view,
				toParentMessage: toSparklineMessage,
				viewInputs: {
					chartId: slotId,
					values,
					color: resolveColor(theme, token),
					className: "h-full w-full",
					revision: 0,
					curve: "monotone",
					fillOpacity: [0.35, 0],
				},
			}),
		],
	)
}

const previewCard = (h: H, theme: ThemeColors, entry: PreviewEntry, sparklines: PageSparklines): Html => {
	const points = sparklines.pointsByMetric.get(entryKey(entry.metricName, entry.metricType)) ?? []
	const values = sparklineValues(entry.metricType, points).map(finiteOrZero)
	const status = sparklines.isLoading
		? "Loading…"
		: sparklines.failedTypes.has(entry.metricType)
			? "Preview unavailable"
			: "Not enough datapoints for a preview"
	return cardButton(
		h,
		{
			onClick: Message.ClickedMetricCard({
				metricName: entry.metricName,
				metricType: entry.metricType,
			}),
			className: "flex flex-col gap-2 p-3",
			attributes: [h.Key(entryKey(entry.metricName, entry.metricType))],
		},
		[
			h.div(
				[h.Class("flex w-full items-start justify-between gap-2")],
				[
					truncatedText(h, {
						text: entry.metricName,
						mono: true,
						className: "text-xs font-medium",
					}),
					metricTypeBadge(h, entry.metricType),
				],
			),
			h.div(
				[h.Class("h-12 w-full")],
				[
					values.length >= 2
						? sparkline(h, theme, entry, values)
						: h.div(
								[h.Class("flex h-full items-center text-3xs text-muted-foreground")],
								[status],
							),
				],
			),
			h.div(
				[h.Class("flex w-full items-center justify-between gap-2 text-3xs text-muted-foreground")],
				[
					h.span(
						[h.Class("truncate")],
						[
							entry.serviceNames.length === 1
								? (entry.serviceNames[0] ?? "")
								: `${entry.serviceNames.length} services`,
						],
					),
					h.span(
						[h.Class("flex shrink-0 items-center gap-1.5")],
						[
							...(entry.metricUnit === ""
								? []
								: [
										badge(
											h,
											{
												variant: "outline",
												size: "xs",
												mono: true,
												className: "text-4xs",
											},
											[entry.metricUnit],
										),
									]),
							entry.metricType === "sum" ? "datapoints/interval" : "avg",
						],
					),
				],
			),
		],
	)
}

/** The loaded grid: every mounted page of cards, then the footer. */
export const previewGrid = (
	h: H,
	model: Model,
	orgId: string,
	theme: ThemeColors,
	rows: Parameters<typeof toEntries>[0],
): Html => {
	const entries = toEntries(rows)
	const shown = Math.min(model.visiblePages * PAGE_SIZE, entries.length)
	const pages = gridPages(entries, model.visiblePages)
	return h.div(
		[h.Class("space-y-3")],
		[
			h.div(
				[h.Class(GRID_CLASS)],
				pages.flatMap((page) => {
					const sparklines = pageSparklines(model, orgId, page)
					return page.map((entry) => previewCard(h, theme, entry, sparklines))
				}),
			),
			listFooter(h, {
				shown,
				total: entries.length,
				noun: "metrics",
				hasMore: entries.length > shown,
				onLoadMore: Message.ClickedLoadMorePages(),
				align: "start",
				className: "justify-start p-0 text-sm",
			}) ?? h.empty,
		],
	)
}
