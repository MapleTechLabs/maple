import { Clock, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineLabWithFlags, type LabEntry } from "../define"
import * as Chart from "../../charts/chart"
import { ChartRuntime, isChartRuntimeReady, LoadChartRuntime } from "../../charts/chart-runtime"
import { ThemeColors } from "../../charts/theme-colors"
import type { Resources } from "../../platform/resources"

// The chart benches' shared state: a canvas chart per id,
// the chart runtime, the resolved theme, and one linked cursor across them.

export const Model = Schema.Struct({
	nowMs: Schema.Number,
	timeZone: Schema.String,
	charts: Schema.Record(Schema.String, Chart.Model),
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	CompletedMountLinkedCursor: {},
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
	model: { ...flags, charts: {}, chartRuntime: ChartRuntime.Loading(), themeColors: null },
	commands: [
		Command.mapMessage(LoadChartRuntime(), (message) =>
			message._tag === "CompletedLoadChartRuntime"
				? Message.CompletedLoadChartRuntime()
				: Message.FailedLoadChartRuntime({ reason: message.reason }),
		),
	],
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
