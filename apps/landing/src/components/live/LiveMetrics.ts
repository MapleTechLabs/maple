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
import { linePreview, noise, RunScript } from "./live-script"

/**
 * A latency chart as a dashboard draws it: the query builder's line chart (`QueryBuilderArea`,
 * through the `area` host) over example percentiles. A new minute arrives every step, so the
 * window slides and the newest bucket is the in-flight one the chart dashes.
 */

const PERCENTILES = ["p50", "p95", "p99"] as const
type Percentile = (typeof PERCENTILES)[number]

const START_MS = Date.UTC(2026, 4, 3, 11, 0, 0)
const BUCKET_MS = 60_000
const WINDOW = 36
const STEP_MS = 1800
const HEIGHT = 190
const TOKENS = ["--border", "--background", "var(--chart-p50)", "var(--chart-p95)", "var(--chart-p99)"]

/** The percentiles of minute `index`: a calm service with a slow patch every 48 minutes. */
const valuesAt = (index: number): Readonly<Record<Percentile, number>> => {
	const slow = Math.max(0, 1 - Math.abs((index % 48) - 30) / 4)
	const p50 = 24 + 3 * Math.sin(index / 5) + noise(index + 1) * 3 + slow * 9
	const p95 = 132 + 14 * Math.sin(index / 7 + 1) + noise(index + 101) * 12 + slow * 150
	return {
		p50: Math.round(p50),
		p95: Math.round(p95),
		p99: Math.round(p95 * 1.7 + noise(index + 201) * 30 + slow * 110),
	}
}

const rowsAt = (step: number) =>
	Arr.makeBy(WINDOW, (offset) => ({
		bucket: new Date(START_MS + (step + offset) * BUCKET_MS).toISOString(),
		...valuesAt(step + offset),
	}))

/** Half a minute into the newest bucket: it is still filling. */
const nowAt = (step: number) => START_MS + (step + WINDOW - 1) * BUCKET_MS + BUCKET_MS / 2

// MODEL

const Model = Schema.Struct({
	/** Minutes the window has slid since the frame started. */
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
		Ticked: () => ({ model: { ...model, step: model.step + 1 } }),
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

const spec = (step: number, colors: ThemeColors): ChartSpec => {
	const data = rowsAt(step)
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
		nowMs: nowAt(step),
		containerWidth: 640,
		gradientPrefix: "landing-metrics",
		showTooltip: true,
		mark: "line",
		curve: "monotone",
		showPoints: false,
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

const preview = (h: HtmlBuilder<Message>, step: number): Html => {
	const rows = rowsAt(step)
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
				viewInputs: { spec: spec(model.step, colors) },
				toParentMessage: (message) => Message.GotChartMessage({ message }),
			}),
		],
	})

/** The newest complete minute, one figure per percentile. */
const figures = (h: HtmlBuilder<Message>, step: number): Html => {
	const latest = valuesAt(step + WINDOW - 2)
	return h.div(
		[h.Class("mb-3 flex flex-wrap gap-x-6 gap-y-2")],
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
					h.span([h.Class("text-fg text-sm font-medium tabular-nums")], [`${latest[key]} ms`]),
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
				[h.Class("px-4 pt-3.5 pb-4"), h.OnMount(RunScript({ everyMs: STEP_MS }))],
				[
					figures(h, model.step),
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
		model: { step: 0, chart: Chart.init(), themeColors: Option.none(), isChartDrawn: false },
	}),
	update,
	view,
})
