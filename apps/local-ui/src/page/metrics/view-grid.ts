import { humanizeUnit, isCounter } from "../../lib/units"
import { validateCssColor } from "@maple/ui/lib/sanitizers"
import { cn } from "@maple/ui/lib/utils"
import * as Chart from "@maple/web/charts/chart"
import * as Sparkline from "@maple/web/charts/sparkline"
import { resolveColor, type ThemeColors } from "@maple/web/charts/theme-colors"
import { METRIC_TYPE_COLORS, metricTypeBadge } from "@maple/web/page/metrics/shared"
import { badge } from "@maple/web/ui/display"
import { truncatedText } from "@maple/web/ui/truncated-text"
import { serviceDot } from "@maple/web/ui/values"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hrefFor } from "../../route"
import type { MetricEntry } from "./catalog"
import { CARD_ROW_HEIGHT, columnsFor, type GridViewport, previewValues, sparklineValues, visibleRows } from "./derive"
import type { SparklinePoint } from "./fetch"
import { MeasureGrid } from "./command"
import { Message } from "./message"

// The Metrics page's grid of metric preview cards.

type H = HtmlBuilder<Message>

/** Sparklines keep no interaction state; one constant Model satisfies the frame. */
const CHART_MODEL = Chart.init()
const toSparklineMessage = (message: Chart.Message) => Message.GotSparklineMessage({ message })

export type GridInputs = Readonly<{
	entries: ReadonlyArray<MetricEntry>
	points: ReadonlyMap<string, ReadonlyArray<SparklinePoint>> | undefined
	isLoading: boolean
	isFailed: boolean
	query: URLSearchParams
	isDimmed: boolean
	viewport: GridViewport
	theme: ThemeColors
}>

const sparkline = (h: H, theme: ThemeColors, entry: MetricEntry, values: ReadonlyArray<number>): Html => {
	const token = validateCssColor(METRIC_TYPE_COLORS.get(entry.metricType) ?? "var(--chart-1)") ?? "var(--chart-1)"
	const slotId = `local-metric-spark-${entry.metricName} ${entry.metricType}`
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

const footer = (h: H, entry: MetricEntry, services: string): Html => {
	const unit = humanizeUnit(entry.metricUnit, entry.metricName)
	const [only] = entry.serviceNames
	return h.div(
		[h.Class("flex w-full items-center justify-between gap-2 text-3xs text-muted-foreground")],
		[
			h.span(
				[h.Class("flex min-w-0 items-center gap-1.5")],
				[
					...(entry.serviceNames.length === 1 && only !== undefined ? [serviceDot(h, { serviceName: only, size: "sm" })] : []),
					h.span([h.Class("truncate")], [services]),
				],
			),
			h.span(
				[h.Class("flex shrink-0 items-center gap-1.5")],
				[
					...(unit ? [badge(h, { variant: "outline", size: "xs", mono: true, className: "text-4xs" }, [unit])] : []),
					isCounter(entry) ? "rate" : "avg",
				],
			),
		],
	)
}

const previewCard = (h: H, inputs: GridInputs, entry: MetricEntry): Html => {
	const values = previewValues(entry, inputs.points?.get(entry.metricName) ?? [])
	const services = entry.serviceNames.length === 1 ? (entry.serviceNames[0] ?? "") : `${entry.serviceNames.length} services`
	const status = inputs.isLoading ? "Loading…" : inputs.isFailed ? "Preview unavailable" : "One datapoint so far"
	return h.a(
		[
			h.Href(hrefFor(`/metrics/${encodeURIComponent(entry.metricName)}`, inputs.query)),
			h.AriaLabel(`${entry.metricName}, ${entry.metricType} metric from ${services}`),
			h.Class(
				"group flex h-[124px] flex-col gap-2 rounded-md border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring",
			),
		],
		[
			h.div(
				[h.Class("flex w-full items-start justify-between gap-2")],
				[truncatedText(h, { text: entry.metricName, mono: true, className: "text-xs font-medium" }), metricTypeBadge(h, entry.metricType)],
			),
			h.div(
				[h.AriaHidden(true), h.Class("h-12 w-full")],
				[
					values.length >= 2
						? sparkline(h, inputs.theme, entry, sparklineValues(values))
						: h.div([h.Class("flex h-full items-center text-3xs text-muted-foreground")], [status]),
				],
			),
			footer(h, entry, services),
		],
	)
}

/** Up to 500 cards in rows of the measured column count; only the rows near the viewport are drawn. */
export const metricGrid = (h: H, inputs: GridInputs): Html => {
	const columns = columnsFor(inputs.viewport.width)
	const rowCount = Math.ceil(inputs.entries.length / columns)
	return h.div(
		[h.Class(cn("h-full overflow-auto", inputs.isDimmed && "opacity-60 transition-opacity")), h.OnMount(MeasureGrid())],
		[
			h.div(
				[h.Class("relative m-4"), h.Style({ height: `${rowCount * CARD_ROW_HEIGHT}px` })],
				visibleRows(rowCount, inputs.viewport).map((index) =>
					h.div(
						[
							h.Key(`row-${index}`),
							h.Class("absolute inset-x-0 grid gap-3"),
							h.Style({
								transform: `translateY(${index * CARD_ROW_HEIGHT}px)`,
								"grid-template-columns": `repeat(${columns}, minmax(0, 1fr))`,
							}),
						],
						inputs.entries
							.slice(index * columns, index * columns + columns)
							.map((entry) => previewCard(h, inputs, entry)),
					),
				),
			),
		],
	)
}
