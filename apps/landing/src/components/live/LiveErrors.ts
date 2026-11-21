import { bucketTooltipBody } from "@maple/views/charts/bucket-tooltip"
import * as Chart from "@maple/views/charts/chart"
import { ChartSpec } from "@maple/views/charts/chart-spec"
import { plotFrame } from "@maple/views/charts/plot-frame"
import { ResolveThemeColors, resolveColor, ThemeColors } from "@maple/views/charts/theme-colors"
import { cn } from "@maple/ui/lib/utils"
import { Option, Schema, Array as Arr } from "effect"
import { Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../../foldkit-island/island"
import { follow, gapMs, noise, plotLayer, RunClock, SCRIPT_MS } from "./live-script"

/**
 * One issue taking events: the dashboard's occurrence chart (`Occurrences`, through the
 * `occurrences` host) over an example day. Events land at uneven intervals; each one counts at
 * once, slides into the list and eases onto the newest hour's bar. The event count climbs and the
 * issue count does not, which is what grouping means.
 */

const START_MS = Date.UTC(2026, 4, 2, 13, 0, 0)
const HOUR_MS = 3_600_000
const HOURS = 24
const HEIGHT = 132
const ERROR_TOKEN = "--severity-error"
/** Events at the first frame. */
const EVENTS_AT_START = 142
const NEWEST_HOUR_AT_START = 9
/** The shortest and longest wait between two events, and how many events it takes for waits to double. */
const QUICK_MS = 380
const SLOW_MS = 3400
const EVENTS_TO_HALVE_THE_RATE = 30
/** Thirty frames a second: plenty for a bar easing up a few pixels. */
const FRAME_MS = 30
const SERVICES = ["checkout-api", "payment-svc", "order-worker"] as const
/** Rows the list shows, and the one more it keeps so a row can slide out as one slides in. */
const ROWS_SHOWN = 3
const ROW_HEIGHT_PX = 33

/** Events in hour `index` of the day: a quiet issue that got loud in the last three hours. */
const countAt = (index: number): number =>
	Math.round(1 + noise(index + 1) * 3 + (index >= HOURS - 4 ? (index - (HOURS - 5)) * 9 : 0))

/** The day's hours; `onNewestBar` is how many of the arrived events the newest bar has taken on. */
const pointsAt = (onNewestBar: number) =>
	Arr.makeBy(HOURS, (index) => ({
		bucket: new Date(START_MS + index * HOUR_MS).toISOString(),
		count: index === HOURS - 1 ? NEWEST_HOUR_AT_START + onNewestBar : countAt(index),
	}))

const hex = (seed: number): string =>
	Math.floor(noise(seed) * 0xffffff)
		.toString(16)
		.padStart(6, "0")

const FIRST_EVENT_MS = Date.UTC(2026, 4, 3, 12, 10, 0)

/** The newest events, newest first. Event `n` is always the same event. */
const eventsAt = (arrived: number) =>
	Arr.makeBy(ROWS_SHOWN + 1, (offset) => {
		const n = EVENTS_AT_START + arrived - offset
		return {
			n,
			time: new Date(FIRST_EVENT_MS + (n - EVENTS_AT_START) * 3000 + Math.floor(noise(n) * 2000))
				.toISOString()
				.slice(11, 19),
			service: SERVICES[n % SERVICES.length] ?? SERVICES[0],
			trace: `${hex(n)}${hex(n + 500).slice(0, 2)}`,
			/** An event that landed while the frame ran slides in; the ones it opened with are just there. */
			landed: offset === 0 && arrived > 0,
		}
	})

// MODEL

const Model = Schema.Struct({
	/** Events that have landed since the frame started. */
	arrived: Schema.Number,
	/** `arrived` as the newest bar shows it: it eases up to each new event. */
	onBar: Schema.Number,
	/** Script time left until the next event lands. */
	untilNextMs: Schema.Number,
	chart: Chart.Model,
	/** Read off the page once the island runs; the server renders plain bars. */
	themeColors: Schema.Option(ThemeColors),
	/** The chart has drawn; until then the plain bars hold the box. */
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
			const lands = left <= 0
			const arrived = lands ? model.arrived + 1 : model.arrived
			// The burst tails off: each event makes the next a little slower to come.
			const thinning = 1 + arrived / EVENTS_TO_HALVE_THE_RATE
			return {
				model: {
					...model,
					arrived,
					onBar: follow(model.onBar, arrived, byMs),
					untilNextMs: lands ? left + gapMs(arrived, QUICK_MS, SLOW_MS) * thinning : left,
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

const plot = Submodel.defineView<Chart.Model, Chart.Message, Readonly<{ spec: ChartSpec }>>(
	(model, inputs, h) =>
		plotFrame(h, {
			chartId: "landing-errors",
			host: "occurrences",
			spec: inputs.spec,
			ariaLabel: "Occurrences of the issue per hour over the last 24 hours",
			className: "h-full",
			tooltipBody: (portal) =>
				Option.flatMap(model.tooltip, (tooltip) =>
					tooltip._tag === "Bucket"
						? Option.some(bucketTooltipBody(h, tooltip, portal))
						: Option.none(),
				),
		}),
)

/** The day's hours as plain bars, inset like the chart's plot area: what a reader without JavaScript sees. */
const preview = (h: HtmlBuilder<Message>, onBar: number): Html => {
	const points = pointsAt(onBar)
	const max = Math.max(1, ...Arr.map(points, (point) => point.count))
	return h.div(
		[
			h.AriaHidden(true),
			h.Class("live-plot-preview absolute inset-0 flex items-end gap-1 pt-2 pb-[22px] pl-11 pr-1"),
		],
		Arr.map(points, (point) =>
			h.div([
				h.Key(point.bucket),
				h.Class("min-w-0 flex-1 rounded-[2px]"),
				h.Style({
					height: `${(point.count / max) * 100}%`,
					"background-color": `var(${ERROR_TOKEN})`,
				}),
			]),
		),
	)
}

const chartPlot = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> =>
	Option.match(model.themeColors, {
		onNone: () => [],
		onSome: (colors) => [
			h.submodel({
				slotId: "landing-errors-plot",
				model: model.chart,
				view: plot,
				viewInputs: {
					spec: ChartSpec.Occurrences({
						// A twentieth of an event is under a pixel: most frames hand the chart the same spec.
						points: pointsAt(Math.round(model.onBar * 20) / 20),
						color: resolveColor(colors, ERROR_TOKEN),
						timeZone: "UTC",
					}),
				},
				toParentMessage: (message) => Message.GotChartMessage({ message }),
			}),
		],
	})

const figure = (h: HtmlBuilder<Message>, label: string, value: string): Html =>
	h.div(
		[h.Key(label), h.Class("flex flex-col gap-0.5")],
		[
			h.span([h.Class("text-fg-muted text-[10px] uppercase tracking-wider")], [label]),
			h.span([h.Class("text-fg text-base font-medium tabular-nums")], [value]),
		],
	)

const events = (h: HtmlBuilder<Message>, arrived: number): Html =>
	h.div(
		[
			h.Class("border-border overflow-hidden border-t"),
			h.Style({ height: `${ROWS_SHOWN * ROW_HEIGHT_PX}px` }),
		],
		Arr.map(eventsAt(arrived), (event) =>
			h.div(
				[
					h.Key(String(event.n)),
					h.Class(
						cn(
							"border-border flex items-center gap-3 border-b px-4 text-xs",
							event.landed && "live-row-in",
						),
					),
					h.Style({ height: `${ROW_HEIGHT_PX}px`, "--live-row": `${ROW_HEIGHT_PX}px` }),
				],
				[
					h.span([h.Class("text-fg-muted tabular-nums")], [event.time]),
					h.span([h.Class("text-fg min-w-0 flex-1 truncate")], [event.service]),
					h.span([h.Class("text-fg-muted shrink-0")], [`trace ${event.trace}`]),
				],
			),
		),
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("live-frame")],
		[
			h.div(
				[h.Class("live-frame__head")],
				[
					h.span([], ["errors · issue"]),
					h.span(
						[h.Class("live-frame__live")],
						[h.span([h.Class("live-frame__live-dot")], []), "DEMO"],
					),
				],
			),
			h.div(
				[h.Class("px-4 pt-3.5 pb-3"), h.OnMount(RunClock({ everyMs: FRAME_MS, forMs: SCRIPT_MS }))],
				[
					h.div(
						[h.Class("mb-3 flex min-w-0 items-baseline gap-2 text-sm")],
						[
							h.span([h.Class("text-fg shrink-0 font-medium")], ["UpstreamError"]),
							h.span([h.Class("text-fg-muted truncate")], ["payment-svc returned 500"]),
						],
					),
					h.div(
						[h.Class("mb-3 flex gap-8")],
						[
							figure(h, "events", String(EVENTS_AT_START + model.arrived)),
							figure(h, "issues", "1"),
							figure(h, "services", String(SERVICES.length)),
						],
					),
					h.div(
						[
							h.Class("relative w-full"),
							h.Style({ height: `${HEIGHT}px` }),
							h.OnMount(ResolveThemeColors({ tokens: [ERROR_TOKEN] })),
						],
						[
							...(model.isChartDrawn ? [] : [preview(h, model.arrived)]),
							plotLayer(h, model.isChartDrawn, chartPlot(h, model)),
						],
					),
				],
			),
			events(h, model.arrived),
		],
	)

export const LiveErrors = makeIsland({
	name: "live-errors",
	Props: Schema.Struct({}),
	Model,
	init: () => ({
		model: {
			arrived: 0,
			onBar: 0,
			untilNextMs: 900,
			chart: Chart.init(),
			themeColors: Option.none(),
			isChartDrawn: false,
		},
	}),
	update,
	view,
})
