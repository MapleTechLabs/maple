import { ChartEnvMessages, ChartEnvFields } from "@maple/views/charts/chart-env"
import { Clock, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineLabWithFlags, type LabEntry } from "../define"
import * as Chart from "@maple/views/charts/chart"
import { ChartRuntime, isChartRuntimeReady, LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import type { Resources } from "../../platform/resources"
import * as HoverCard from "@maple/views/ui/hover-card"
import { initMarkerCard } from "../../page/kit/service-metrics/marker-card"

// The chart benches' shared state: a canvas chart per id,
// the chart runtime, the resolved theme, one linked cursor across them, and the span a drag zoomed to.

export const Model = Schema.Struct({
	nowMs: Schema.Number,
	timeZone: Schema.String,
	charts: Schema.Record(Schema.String, Chart.Model),
	/** The span the last drag selected; a page writes it to its URL, a bench narrows its rows. */
	zoom: Schema.NullOr(Schema.Struct({ startMs: Schema.Number, endMs: Schema.Number })),
	/** The commit markers' hover card, on the benches that draw markers. */
	markerCard: HoverCard.Model,
	...ChartEnvFields,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
	...ChartEnvMessages,
	CompletedMountLinkedCursor: {},
	SelectedChartRange: { startMs: Schema.Number, endMs: Schema.Number },
	GotMarkerCardMessage: { message: HoverCard.Message },
})
export type Message = typeof Message.Type

export const BenchFlags = Schema.Struct({ nowMs: Schema.Number, timeZone: Schema.String })
export type BenchFlags = typeof BenchFlags.Type

export const benchFlags: Effect.Effect<BenchFlags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	timeZone: Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
})

type Return = Update.Return<Model, Message, Resources>

export const init = (flags: BenchFlags): Return => ({
	model: {
		...flags,
		charts: {},
		zoom: null,
		markerCard: initMarkerCard("bench-marker-card"),
		chartRuntime: ChartRuntime.Loading(),
		themeColors: null,
	},
	commands: [LoadChartRuntime()],
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotChartMessage: ({ chartId, message: inner }) => {
			const next = Chart.update(model.charts[chartId] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: { ...model.charts, [chartId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotChartMessage({ chartId, message: child }),
				),
			}
		},
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: ChartRuntime.Ready() } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: ChartRuntime.Failed({ reason }) },
		}),
		CompletedMountLinkedCursor: () => ({ model }),
		SelectedChartRange: (zoom) => ({ model: { ...model, zoom } }),
		GotMarkerCardMessage: ({ message: inner }) => {
			const next = HoverCard.update(model.markerCard, inner)
			return {
				model: { ...model, markerCard: next.model },
				commands: Command.mapMessages(next.commands ?? [], (card) =>
					Message.GotMarkerCardMessage({ message: card }),
				),
			}
		},
	})

export const isReady = (model: Model): boolean =>
	model.themeColors !== null && isChartRuntimeReady(model.chartRuntime)

export const toChart = (chartId: string) => (message: Chart.Message) =>
	Message.GotChartMessage({ chartId, message })

/** A chart bench page: the shared state under its own view. */
export const defineChartBench = (
	title: string,
	view: (model: Model, h: HtmlBuilder<Message>) => Html,
): LabEntry => defineLabWithFlags(title, { Model, Flags: BenchFlags, flags: benchFlags, init, update, view })
