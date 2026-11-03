import { bucketTooltipBody } from "@maple/views/charts/bucket-tooltip"
import * as Chart from "@maple/views/charts/chart"
import { ChartSpec } from "@maple/views/charts/chart-spec"
import { plotFrame } from "@maple/views/charts/plot-frame"
import { ResolveThemeColors, resolveColor, ThemeColors } from "@maple/views/charts/theme-colors"
import { Effect, Option, Schema, Array as Arr, Record as Rec } from "effect"
import { Mount, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../../foldkit-island/island"
import { formatNumber, stubBuckets, totalCount } from "./live-logs-volume-data"

/**
 * The /logs severity histogram over the stub buckets, drawn by the dashboard's `LogsVolume`
 * definition through the `logs-volume` host, which carries only that definition.
 */

/** Bottom to top. */
const STACK_ORDER = ["DEBUG", "INFO", "WARN", "ERROR"] as const

const SEVERITY_TOKENS = {
	DEBUG: "--severity-debug",
	INFO: "--severity-info",
	WARN: "--severity-warn",
	ERROR: "--severity-error",
} as const satisfies Record<(typeof STACK_ORDER)[number], string>
const THEME_TOKENS = [...Rec.values(SEVERITY_TOKENS), "--border"]

const HEIGHT = 140

const buckets = Arr.map(stubBuckets, ({ bucket, ...counts }) => ({ bucket, counts }))
const total = totalCount(stubBuckets)

// MODEL

const Model = Schema.Struct({
	chart: Chart.Model,
	/** Read off the page once the island runs; the server renders the empty plot box. */
	themeColors: Schema.Option(ThemeColors),
	/** The viewer's zone, which the axis ticks and tooltip heading follow. */
	timeZone: Schema.Option(Schema.String),
	/** The chart has drawn; until then the static preview holds the box. */
	isChartDrawn: Schema.Boolean,
})
type Model = typeof Model.Type

// MESSAGE

const Message = defineMessageUnion({
	ResolvedThemeColors: { colors: ThemeColors },
	ReadTimeZone: { timeZone: Schema.String },
	GotChartMessage: { message: Chart.Message },
})
type Message = typeof Message.Type

/** The browser's time zone, as the old chart's `toLocaleTimeString` ticks used. */
const ReadViewerTimeZone = Mount.define("ReadViewerTimeZone", {
	messages: [Message.ReadTimeZone],
	execute: () =>
		Effect.sync(() =>
			Message.ReadTimeZone({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
		),
})

// UPDATE

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: Option.some(colors) } }),
		ReadTimeZone: ({ timeZone }) => ({ model: { ...model, timeZone: Option.some(timeZone) } }),
		GotChartMessage: ({ message: inner }) => ({
			model: {
				...model,
				chart: Chart.update(model.chart, inner).model,
				isChartDrawn: model.isChartDrawn || inner._tag === "CompletedMountChart",
			},
		}),
	})

// VIEW

const spec = (colors: ThemeColors, timeZone: string): ChartSpec =>
	ChartSpec.LogsVolume({
		buckets,
		seriesKeys: [...STACK_ORDER],
		colors: Rec.fromEntries(
			Arr.map(STACK_ORDER, (key) => [key, resolveColor(colors, SEVERITY_TOKENS[key])]),
		),
		border: resolveColor(colors, "--border"),
		selection: null,
		isSelecting: false,
		timeZone,
	})

const plot = Submodel.defineView<Chart.Model, Chart.Message, Readonly<{ spec: ChartSpec }>>(
	(model, inputs, h) =>
		plotFrame(h, {
			chartId: "landing-logs-volume",
			host: "logs-volume",
			spec: inputs.spec,
			ariaLabel: "Log volume by severity",
			className: "h-full",
			tooltipBody: (portal) =>
				Option.flatMap(model.tooltip, (tooltip) =>
					tooltip._tag === "Bucket"
						? Option.some(bucketTooltipBody(h, tooltip, portal))
						: Option.none(),
				),
		}),
)

const stackedMax = Math.max(
	1,
	...Arr.map(stubBuckets, (bucket) => Arr.reduce(STACK_ORDER, 0, (sum, key) => sum + bucket[key])),
)

/**
 * The stub buckets as plain stacked columns, inset like the chart's plot area: what the server
 * renders and what shows until the chart has drawn over it.
 */
const preview = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.AriaHidden(true), h.Class("absolute inset-0 flex items-end gap-px pt-1 pb-[22px] pl-10")],
		Arr.map(stubBuckets, (bucket) =>
			h.div(
				[h.Key(bucket.bucket), h.Class("flex h-full min-w-0 flex-1 flex-col-reverse")],
				Arr.map(STACK_ORDER, (key) =>
					h.div([
						h.Style({
							height: `${(bucket[key] / stackedMax) * 100}%`,
							"background-color": `var(${SEVERITY_TOKENS[key]})`,
						}),
					]),
				),
			),
		),
	)

const chartPlot = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> =>
	Option.match(Option.all({ colors: model.themeColors, timeZone: model.timeZone }), {
		onNone: () => [],
		onSome: ({ colors, timeZone }) => [
			h.submodel({
				slotId: "landing-logs-volume-plot",
				model: model.chart,
				view: plot,
				viewInputs: { spec: spec(colors, timeZone) },
				toParentMessage: (message) => Message.GotChartMessage({ message }),
			}),
		],
	})

const chartBox = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.div(
		[
			h.Class("relative w-full"),
			h.Style({ height: `${HEIGHT}px` }),
			h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS })),
		],
		[...(model.isChartDrawn ? [] : [preview(h)]), ...chartPlot(h, model)],
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("live-frame")],
		[
			h.div(
				[h.Class("live-frame__head")],
				[
					h.span([], ["logs · volume · last 5h"]),
					h.span(
						[h.Class("live-frame__live")],
						[h.span([h.Class("live-frame__live-dot")], []), "LIVE"],
					),
				],
			),
			h.div(
				[h.Class("px-4 pt-3 pb-4"), h.OnMount(ReadViewerTimeZone())],
				[
					h.div(
						[h.Class("mb-2 flex items-baseline gap-2")],
						[
							h.span(
								[h.Class("text-fg text-sm font-medium tabular-nums")],
								[`${formatNumber(total)} logs`],
							),
							h.span([h.Class("text-fg-muted text-xs")], ["in selected range"]),
						],
					),
					chartBox(h, model),
				],
			),
			h.div(
				[
					h.Class(
						"border-border bg-bg-elevated text-fg-muted flex justify-between border-t px-3.5 py-2.5 text-[10px] uppercase tracking-wider",
					),
				],
				[
					h.span([], ["4 severities · 60 buckets · 5m each"]),
					h.span([], ["warn cluster 11:10–11:40 · error blip 11:50"]),
				],
			),
		],
	)

export const LiveLogsVolumeChart = makeIsland({
	name: "live-logs-volume-chart",
	Props: Schema.Struct({}),
	Model,
	init: () => ({
		model: {
			chart: Chart.init(),
			themeColors: Option.none(),
			timeZone: Option.none(),
			isChartDrawn: false,
		},
	}),
	update,
	view,
})
