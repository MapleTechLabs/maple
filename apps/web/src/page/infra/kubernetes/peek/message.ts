import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ThemeColors } from "../../../../charts/theme-colors"
import { LoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import { SeriesResult } from "../../kit/series"
import { fetchPodSeries, fetchPodSummary, PodSeriesInput, PodSummary, PodSummaryInput } from "../pod-data"

export const Step = Schema.Literals([1, -1])
export type Step = typeof Step.Type

export const Message = defineMessageUnion({
	CompletedFetchSummary: {
		podKey: Schema.String,
		key: Schema.String,
		result: Schema.Result(PodSummary, LoadFailure),
	},
	CompletedFetchSeries: { id: Schema.String, key: Schema.String, result: SeriesResult },
	ClickedStep: { step: Step },
	/** `MountPeekKeys`: ↓/J forward, ↑/K back. */
	PressedStepKey: { step: Step },
	ClickedRetrySummary: {},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { id: Schema.String, message: Chart.Message },
	GotDialogMessage: { message: Dialog.Message },
})
export type Message = typeof Message.Type

/** What the list acts on: a step walks its rows, a close clears `peek` from the URL. */
export const OutMessage = defineMessageUnion({
	RequestedStep: { step: Step },
	Closed: {},
})
export type OutMessage = typeof OutMessage.Type

export const FetchPeekSummary = Command.define("FetchInfraPodPeekSummary", {
	args: { podKey: Schema.String, key: Schema.String, input: PodSummaryInput },
	messages: [Message.CompletedFetchSummary],
	execute: ({ podKey, key, input }) =>
		Effect.map(fetchPodSummary(input), (result) =>
			Message.CompletedFetchSummary({ podKey, key, result }),
		),
})

export const FetchPeekSeries = Command.define("FetchInfraPodPeekSeries", {
	args: { id: Schema.String, key: Schema.String, input: PodSeriesInput },
	messages: [Message.CompletedFetchSeries],
	execute: ({ id, key, input }) =>
		Effect.map(fetchPodSeries(input), (result) => Message.CompletedFetchSeries({ id, key, result })),
})
