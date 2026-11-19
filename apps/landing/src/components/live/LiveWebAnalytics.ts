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
import { linePreview, noise, RunScript } from "./live-script"

/**
 * The Web Analytics page's traffic chart (`AnalyticsTraffic`, through the `analytics-traffic`
 * host) over an example week, with the totals above it. Each step is a few more visits in the
 * newest bucket, so the tail of the chart and the totals climb together.
 */

const START_MS = Date.UTC(2026, 3, 27, 0, 0, 0)
const BUCKET_MS = 2 * 3_600_000
const BUCKETS = 84
const STEP_MS = 1700
const HEIGHT = 200
const LOOP = 30
const VISITORS_TOKEN = "var(--chart-1)"
const PAGE_VIEWS_TOKEN = "var(--chart-2)"
const TOKENS = ["--border", "--background", VISITORS_TOKEN, PAGE_VIEWS_TOKEN]

/** How busy bucket `index` is, 0 to 1: a day's rise and fall, quieter at the weekend. */
const busy = (index: number): number => {
	const day = Math.floor(index / 12)
	const hour = (index % 12) / 12
	return (0.2 + 0.8 * Math.max(0, Math.sin(hour * Math.PI))) * (day % 7 >= 5 ? 0.6 : 1)
}

const visitorsAt = (index: number): number => Math.round(busy(index) * 520 + noise(index + 1) * 60)
const pageViewsAt = (index: number): number => Math.round(visitorsAt(index) * (3.6 + noise(index + 301)))

/** What a step adds to the newest bucket. */
const VISITORS_PER_STEP = 7
const PAGE_VIEWS_PER_STEP = 26
const NEWEST_AT_START = { visitors: 96, pageViews: 340 }

const pointsAt = (step: number) =>
	Arr.makeBy(BUCKETS, (index) => {
		const newest = index === BUCKETS - 1
		return {
			bucket: new Date(START_MS + index * BUCKET_MS).toISOString(),
			primary: newest ? NEWEST_AT_START.visitors + step * VISITORS_PER_STEP : visitorsAt(index),
			companion: newest ? NEWEST_AT_START.pageViews + step * PAGE_VIEWS_PER_STEP : pageViewsAt(index),
		}
	})

const sum = (values: ReadonlyArray<number>): number => Arr.reduce(values, 0, (total, value) => total + value)

const count = (value: number): string => value.toLocaleString("en-US")

/** The totals over the week, as the tiles read them. */
const tilesAt = (step: number) => {
	const points = pointsAt(step)
	const visitors = sum(Arr.map(points, (point) => point.primary))
	const pageViews = sum(Arr.map(points, (point) => point.companion))
	return [
		{ label: "Unique visitors", value: count(visitors) },
		{ label: "Page views", value: count(pageViews) },
		{ label: "Pages / session", value: (pageViews / (visitors * 1.18)).toFixed(1) },
		{ label: "Online now", value: String(31 + Math.round(noise(step + 77) * 12)) },
	]
}

// MODEL

const Model = Schema.Struct({
	/** Steps since the frame started; it starts over after `LOOP`. */
	step: Schema.Number,
	chart: Chart.Model,
	/** Read off the page once the island runs; the server renders the plain lines. */
	themeColors: Schema.Option(ThemeColors),
	/** The chart has drawn; until then the plain lines hold the box. */
	isChartDrawn: Schema.Boolean,
})
type Model = typeof Model.Type

// MESSAGE

const Message = defineMessageUnion({
	Ticked: {},
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { message: Chart.Message },
})
type Message = typeof Message.Type

// UPDATE

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		Ticked: () => ({ model: { ...model, step: (model.step + 1) % LOOP } }),
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

const spec = (step: number, colors: ThemeColors): ChartSpec =>
	ChartSpec.AnalyticsTraffic({
		points: pointsAt(step),
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

const preview = (h: HtmlBuilder<Message>, step: number): Html => {
	const points = pointsAt(step)
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
				viewInputs: { spec: spec(model.step, colors) },
				toParentMessage: (message) => Message.GotChartMessage({ message }),
			}),
		],
	})

const tiles = (h: HtmlBuilder<Message>, step: number): Html =>
	h.div(
		[h.Class("border-border grid grid-cols-2 border-b sm:grid-cols-4")],
		Arr.map(tilesAt(step), (tile) =>
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
			tiles(h, model.step),
			h.div(
				[h.Class("px-4 pt-3 pb-4"), h.OnMount(RunScript({ everyMs: STEP_MS }))],
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
						[...(model.isChartDrawn ? [] : [preview(h, model.step)]), ...chartPlot(h, model)],
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
		model: { step: 0, chart: Chart.init(), themeColors: Option.none(), isChartDrawn: false },
	}),
	update,
	view,
})
