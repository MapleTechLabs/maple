import { bucketTooltipBody } from "@maple/views/charts/bucket-tooltip"
import * as Chart from "@maple/views/charts/chart"
import { ChartSpec } from "@maple/views/charts/chart-spec"
import { plotFrame } from "@maple/views/charts/plot-frame"
import { ResolveThemeColors, resolveColor, ThemeColors } from "@maple/views/charts/theme-colors"
import { SERIES_FALLBACK_COLOR, seriesColorTokens, seriesDefinitionsOf } from "@maple/views/charts/timeseries"
import { Option, Schema, Array as Arr, Record as Rec } from "effect"
import { Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../../foldkit-island/island"
import { linePreview, plotLayer, RunClock, SCRIPT_MS } from "./live-script"

/**
 * A latency chart as a dashboard draws it: the query builder's line chart (`QueryBuilderArea`,
 * through the `area` host) over example percentiles. Time runs on, so the line glides to the left
 * a little every frame and the newest bucket is the in-flight one the chart dashes.
 */

const PERCENTILES = ["p50", "p95", "p99"] as const
type Percentile = (typeof PERCENTILES)[number]

const START_MS = Date.UTC(2026, 4, 3, 11, 0, 0)
const BUCKET_MS = 60_000
const WINDOW = 36
/** Script time a bucket takes to cross its own width. */
const MS_PER_BUCKET = 4200
/** Twenty frames a second is smooth for a line moving two pixels a second. */
const FRAME_MS = 50
const HEIGHT = 190
/** Above the highest p99 the example data reaches. */
const AXIS_TOP_MS = 700
const TOKENS = ["--border", "--background", "var(--chart-p50)", "var(--chart-p95)", "var(--chart-p99)"]

/**
 * The percentiles at minute `at`, whole or not: a calm service with a slow patch every 64 minutes.
 * Smooth in `at`, so sampling it a little later moves the line without changing its shape.
 */
const valuesAt = (at: number): Readonly<Record<Percentile, number>> => {
	const slow = Math.exp(-(((at % 64) - 40) ** 2) / 30)
	const p50 = 24 + 3 * Math.sin(at / 5) + 1.5 * Math.sin(at / 2.1 + 1) + slow * 9
	const p95 = 132 + 14 * Math.sin(at / 7 + 1) + 8 * Math.sin(at / 2.6) + slow * 150
	const p99 = p95 * 1.7 + 12 * Math.sin(at / 3.3 + 2) + slow * 110
	return { p50: Math.round(p50 * 10) / 10, p95: Math.round(p95 * 10) / 10, p99: Math.round(p99 * 10) / 10 }
}

/** The window once `minutes` of example time have passed. */
const rowsAt = (minutes: number) =>
	Arr.makeBy(WINDOW, (offset) => ({
		bucket: new Date(START_MS + (minutes + offset) * BUCKET_MS).toISOString(),
		...valuesAt(minutes + offset),
	}))

/** Half a minute into the newest bucket: it is still filling. */
const nowAt = (minutes: number) => START_MS + (minutes + WINDOW - 1) * BUCKET_MS + BUCKET_MS / 2

// MODEL

const Model = Schema.Struct({
	/** Minutes of example time that have passed since the frame started. */
	minutes: Schema.Number,
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
		Advanced: ({ byMs }) => ({ model: { ...model, minutes: model.minutes + byMs / MS_PER_BUCKET } }),
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

const spec = (minutes: number, colors: ThemeColors): ChartSpec => {
	const data = rowsAt(minutes)
	const tokens = seriesColorTokens(seriesDefinitionsOf(data).definitions)
	return ChartSpec.QueryBuilderArea({
		data,
		colors: Rec.fromEntries(Arr.map([...tokens], ([key, token]) => [key, resolveColor(colors, token)])),
		hidden: [],
		fallbackColor: SERIES_FALLBACK_COLOR,
		chrome: {
			border: resolveColor(colors, "--border"),
			background: resolveColor(colors, "--background"),
		},
		unit: "duration_ms",
		timeZone: "UTC",
		nowMs: nowAt(minutes),
		containerWidth: 640,
		gradientPrefix: "landing-metrics",
		showTooltip: true,
		mark: "line",
		curve: "monotone",
		showPoints: false,
		// The slow patch's peak is always inside the axis, so the scale holds as the patch glides in and out.
		axis: { thresholds: [], logScale: false, softMin: 0, softMax: AXIS_TOP_MS, fitYAxisToData: false },
	})
}

const plot = Submodel.defineView<Chart.Model, Chart.Message, Readonly<{ spec: ChartSpec }>>(
	(model, inputs, h) =>
		plotFrame(h, {
			chartId: "landing-metrics",
			host: "area",
			spec: inputs.spec,
			ariaLabel: "Request latency percentiles for checkout-api over the last 36 minutes",
			className: "h-full",
			tooltipBody: (portal) =>
				Option.flatMap(model.tooltip, (tooltip) =>
					tooltip._tag === "Bucket"
						? Option.some(bucketTooltipBody(h, tooltip, portal))
						: Option.none(),
				),
		}),
)

const preview = (h: HtmlBuilder<Message>, minutes: number): Html => {
	const rows = rowsAt(minutes)
	return linePreview(
		h,
		Arr.map(PERCENTILES, (key) => ({
			values: Arr.map(rows, (row) => row[key]),
			color: `var(--chart-${key})`,
		})),
		"absolute inset-0 h-full w-full pt-2 pb-[26px] pl-12 pr-2",
	)
}

const chartPlot = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> =>
	Option.match(model.themeColors, {
		onNone: () => [],
		onSome: (colors) => [
			h.submodel({
				slotId: "landing-metrics-plot",
				model: model.chart,
				view: plot,
				viewInputs: { spec: spec(model.minutes, colors) },
				toParentMessage: (message) => Message.GotChartMessage({ message }),
			}),
		],
	})

/** The newest complete minute, one figure per percentile: they change when a minute closes, not every frame. */
const figures = (h: HtmlBuilder<Message>, minutes: number): Html => {
	const latest = valuesAt(Math.floor(minutes) + WINDOW - 2)
	return h.div(
		[h.Class("mb-3 flex gap-x-5 whitespace-nowrap")],
		Arr.map(PERCENTILES, (key) =>
			h.div(
				[h.Key(key), h.Class("flex items-baseline gap-2")],
				[
					h.span(
						[
							h.Class("inline-block size-2 self-center rounded-[2px]"),
							h.Style({ "background-color": `var(--chart-${key})` }),
						],
						[],
					),
					h.span([h.Class("text-fg-muted text-xs")], [key]),
					h.span(
						[h.Class("text-fg text-sm font-medium tabular-nums")],
						[`${Math.round(latest[key])} ms`],
					),
				],
			),
		),
	)
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("live-frame")],
		[
			h.div(
				[h.Class("live-frame__head")],
				[
					h.span([], ["metrics · http.server.request.duration"]),
					h.span(
						[h.Class("live-frame__live")],
						[h.span([h.Class("live-frame__live-dot")], []), "DEMO"],
					),
				],
			),
			h.div(
				[h.Class("px-4 pt-3.5 pb-4"), h.OnMount(RunClock({ everyMs: FRAME_MS, forMs: SCRIPT_MS }))],
				[
					figures(h, model.minutes),
					h.div(
						[
							h.Class("relative w-full"),
							h.Style({ height: `${HEIGHT}px` }),
							h.OnMount(ResolveThemeColors({ tokens: TOKENS })),
						],
						[
							...(model.isChartDrawn ? [] : [preview(h, model.minutes)]),
							plotLayer(h, model.isChartDrawn, chartPlot(h, model)),
						],
					),
				],
			),
			h.div(
				[
					h.Class(
						"border-border bg-bg-elevated text-fg-muted flex justify-between gap-4 border-t px-3.5 py-2.5 text-[10px] uppercase tracking-wider",
					),
				],
				[h.span([], ["checkout-api · 1m buckets"]), h.span([], ["same spans as the trace view"])],
			),
		],
	)

export const LiveMetrics = makeIsland({
	name: "live-metrics",
	Props: Schema.Struct({}),
	Model,
	init: () => ({
		model: { minutes: 0, chart: Chart.init(), themeColors: Option.none(), isChartDrawn: false },
	}),
	update,
	view,
})
