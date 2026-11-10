import { resolveWindowCommand } from "../../../kit/time-frame"
import { reloadSpin } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { TimeWindow } from "../../../../data/time-range"
import { loadTraced } from "../../kit/traced"
import { loadTimeseries, TimeseriesInput } from "../data"
import { Message } from "./message"

export const ResolveWindow = resolveWindowCommand("ResolveAwsResourceWindow", Message.CompletedResolveWindow)

export const FetchTimeseries = Command.define("FetchAwsResourceTimeseries", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, input }) =>
		Effect.map(loadTimeseries(input), (result) => Message.CompletedFetchTimeseries({ key, result })),
})

export const FetchTraced = Command.define("FetchAwsResourceTraced", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchTraced],
	execute: ({ key, window }) =>
		Effect.map(loadTraced(window), (result) => Message.CompletedFetchTraced({ key, result })),
})

export const CompleteReloadSpin = reloadSpin("CompleteAwsResourceReloadSpin", Message.CompletedReloadSpin)
