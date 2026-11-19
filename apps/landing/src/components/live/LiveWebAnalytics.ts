import { bucketTooltipBody } from "@maple/views/charts/bucket-tooltip"
import * as Chart from "@maple/views/charts/chart"
import { ChartSpec } from "@maple/views/charts/chart-spec"
import { plotFrame } from "@maple/views/charts/plot-frame"
import { ResolveThemeColors, resolveColor, ThemeColors } from "@maple/views/charts/theme-colors"
import { Option, Schema, Array as Arr } from "effect"
import { Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../../foldkit-island/island"
import { gapMs, linePreview, noise, plotLayer, RunClock, SCRIPT_MS } from "./live-script"

/**
 * The Web Analytics page's traffic chart (`AnalyticsTraffic`, through the `analytics-traffic`
 * host) over an example week, with the totals above it. Visits land at uneven intervals; each
 * one adds a visitor and a few page views to the totals and to the newest bucket of the chart.
 */

const START_MS = Date.UTC(2026, 3, 27, 0, 0, 0)
const BUCKET_MS = 2 * 3_600_000
const BUCKETS = 84
const HEIGHT = 200
const VISITORS_TOKEN = "var(--chart-1)"
const PAGE_VIEWS_TOKEN = "var(--chart-2)"
const TOKENS = ["--border", "--background", VISITORS_TOKEN, PAGE_VIEWS_TOKEN]
/** The shortest and longest wait between two visits. */
const QUICK_MS = 240
const SLOW_MS = 2100
/** Nothing here eases, so the clock only has to notice a visit landing. */
const FRAME_MS = 100
/** People on the site right now stay within this range. */
const ONLINE = { atStart: 34, least: 26, most: 47 }

/** How busy bucket `index` is, 0 to 1: a day's rise and fall, quieter at the weekend. */
const busy = (index: number): number => {
	const day = Math.floor(index / 12)
	const hour = (index % 12) / 12
	return (0.2 + 0.8 * Math.max(0, Math.sin(hour * Math.PI))) * (day % 7 >= 5 ? 0.6 : 1)
}

const visitorsAt = (index: number): number => Math.round(busy(index) * 520 + noise(index + 1) * 60)
const pageViewsAt = (index: number): number => Math.round(visitorsAt(index) * (3.6 + noise(index + 301)))

/** The newest bucket as the frame opens: early in its two hours. */
const NEWEST_AT_START = { visitors: 96, pageViews: 340 }

/** Pages visit `index` reads, two to five. */
const pagesOf = (index: number): number => 2 + Math.floor(noise(index + 900) * 4)

/** Whether visit `index` is someone arriving, someone leaving, or neither, for the online count. */
const onlineChangeOf = (index: number): number => {
	const roll = noise(index + 33)
	return roll < 0.22 ? 1 : roll > 0.82 ? -1 : 0
}

const pointsAt = (visits: number, pageViews: number) =>
	Arr.makeBy(BUCKETS, (index) => {
		const newest = index === BUCKETS - 1
		return {
			bucket: new Date(START_MS + index * BUCKET_MS).toISOString(),
			primary: newest ? NEWEST_AT_START.visitors + visits : visitorsAt(index),
			companion: newest ? NEWEST_AT_START.pageViews + pageViews : pageViewsAt(index),
		}
	})

const sum = (values: ReadonlyArray<number>): number => Arr.reduce(values, 0, (total, value) => total + value)

const count = (value: number): string => value.toLocaleString("en-US")

/** The totals over the week, as the tiles read them. */
const tilesAt = (model: Readonly<{ visits: number; pageViews: number; online: number }>) => {
	const points = pointsAt(model.visits, model.pageViews)
	const visitors = sum(Arr.map(points, (point) => point.primary))
	const pageViews = sum(Arr.map(points, (point) => point.companion))
	return [
		{ label: "Unique visitors", value: count(visitors) },
		{ label: "Page views", value: count(pageViews) },
		{ label: "Pages / session", value: (pageViews / (visitors * 1.18)).toFixed(1) },
		{ label: "Online now", value: String(model.online) },
	]
}

// MODEL

const Model = Schema.Struct({
	/** Visits that have landed since the frame started, and the pages they read. */
	visits: Schema.Number,
	pageViews: Schema.Number,
	online: Schema.Number,
	/** Script time left until the next visit lands. */
	untilNextMs: Schema.Number,
	chart: Chart.Model,
	/** Read off the page once the island runs; the server renders the plain lines. */
	themeColors: Schema.Option(ThemeColors),
	/** The chart has drawn; until then the plain lines hold the box. */
	isChartDrawn: Schema.Boolean,
})
type Model = typeof Model.Type

// MESSAGE

const Message = defineMessageUnion({
	Advanced: { byMs: Schema.Number },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { message: Chart.Message },
})
type Message = typeof Message.Type

// UPDATE

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		Advanced: ({ byMs }) => {
			const left = model.untilNextMs - byMs
			if (left > 0) return { model: { ...model, untilNextMs: left } }
			const visits = model.visits + 1
			return {
				model: {
					...model,
					visits,
					pageViews: model.pageViews + pagesOf(visits),
					online: Math.min(
						ONLINE.most,
						Math.max(ONLINE.least, model.online + onlineChangeOf(visits)),
					),
					untilNextMs: left + gapMs(visits, QUICK_MS, SLOW_MS),
				},
			}
		},
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: Option.some(colors) } }),
		GotChartMessage: ({ message: inner }) => ({
			model: {
				...model,
				chart: Chart.update(model.chart, inner).model,
				isChartDrawn: model.isChartDrawn || inner._tag === "CompletedMountChart",
			},
		}),
	})

// VIEW

const spec = (model: Model, colors: ThemeColors): ChartSpec =>
	ChartSpec.AnalyticsTraffic({
		points: pointsAt(model.visits, model.pageViews),
		series: [
			{ key: "companion", metric: "pageViews" },
			{ key: "primary", metric: "visitors" },
		],
		tickMetric: "pageViews",
		colors: {
			primary: resolveColor(colors, VISITORS_TOKEN),
			companion: resolveColor(colors, PAGE_VIEWS_TOKEN),
			border: resolveColor(colors, "--border"),
			background: resolveColor(colors, "--background"),
		},
		timeZone: "UTC",
		gradientPrefix: "landing-analytics",
		isNarrow: false,
	})

const plot = Submodel.defineView<Chart.Model, Chart.Message, Readonly<{ spec: ChartSpec }>>(
	(model, inputs, h) =>
		plotFrame(h, {
			chartId: "landing-analytics",
			host: "analytics-traffic",
			spec: inputs.spec,
			ariaLabel: "Unique visitors and page views over the last 7 days",
			className: "h-full",
			tooltipBody: (portal) =>
				Option.flatMap(model.tooltip, (tooltip) =>
					tooltip._tag === "Bucket"
						? Option.some(bucketTooltipBody(h, tooltip, portal))
						: Option.none(),
				),
		}),
)

const preview = (h: HtmlBuilder<Message>, model: Model): Html => {
	const points = pointsAt(model.visits, model.pageViews)
	return linePreview(
		h,
		[
			{ values: Arr.map(points, (point) => point.companion), color: PAGE_VIEWS_TOKEN },
			{ values: Arr.map(points, (point) => point.primary), color: VISITORS_TOKEN },
		],
		"absolute inset-0 h-full w-full pt-1 pb-[26px] pl-[52px] pr-2",
	)
}

const chartPlot = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> =>
	Option.match(model.themeColors, {
		onNone: () => [],
		onSome: (colors) => [
			h.submodel({
				slotId: "landing-analytics-plot",
				model: model.chart,
				view: plot,
				viewInputs: { spec: spec(model, colors) },
				toParentMessage: (message) => Message.GotChartMessage({ message }),
			}),
		],
	})

const tiles = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.div(
		[h.Class("border-border grid grid-cols-2 border-b sm:grid-cols-4")],
		Arr.map(tilesAt(model), (tile) =>
			h.div(
				[
					h.Key(tile.label),
					h.Class("border-border flex flex-col gap-1 border-r px-4 py-3 last:border-r-0"),
				],
				[
					h.span([h.Class("text-fg-muted text-[10px] uppercase tracking-wider")], [tile.label]),
					h.span([h.Class("text-fg text-lg font-medium tabular-nums")], [tile.value]),
				],
			),
		),
	)

const legendEntry = (h: HtmlBuilder<Message>, label: string, token: string): Html =>
	h.span(
		[h.Key(label), h.Class("flex items-center gap-1.5")],
		[
			h.span(
				[h.Class("inline-block size-2 rounded-[2px]"), h.Style({ "background-color": token })],
				[],
			),
			label,
		],
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("live-frame")],
		[
			h.div(
				[h.Class("live-frame__head")],
				[
					h.span([], ["web analytics · last 7 days"]),
					h.span(
						[h.Class("live-frame__live")],
						[h.span([h.Class("live-frame__live-dot")], []), "DEMO"],
					),
				],
			),
			tiles(h, model),
			h.div(
				[h.Class("px-4 pt-3 pb-4"), h.OnMount(RunClock({ everyMs: FRAME_MS, forMs: SCRIPT_MS }))],
				[
					h.div(
						[h.Class("text-fg-muted mb-2 flex gap-4 text-xs")],
						[
							legendEntry(h, "Unique visitors", VISITORS_TOKEN),
							legendEntry(h, "Page views", PAGE_VIEWS_TOKEN),
						],
					),
					h.div(
						[
							h.Class("relative w-full"),
							h.Style({ height: `${HEIGHT}px` }),
							h.OnMount(ResolveThemeColors({ tokens: TOKENS })),
						],
						[
							...(model.isChartDrawn ? [] : [preview(h, model)]),
							plotLayer(h, model.isChartDrawn, chartPlot(h, model)),
						],
					),
				],
			),
		],
	)

export const LiveWebAnalytics = makeIsland({
	name: "live-web-analytics",
	Props: Schema.Struct({}),
	Model,
	init: () => ({
		model: {
			visits: 0,
			pageViews: 0,
			online: ONLINE.atStart,
			untilNextMs: 700,
			chart: Chart.init(),
			themeColors: Option.none(),
			isChartDrawn: false,
		},
	}),
	update,
	view,
})
