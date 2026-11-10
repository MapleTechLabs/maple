import { resolveWindowCommand } from "../../../kit/time-frame"
import { reloadSpin } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { TimeWindow } from "../../../../data/time-range"
import { loadTraced } from "../../kit/traced"
import { loadRailwayServices, loadRailwayTimeseries } from "../data"
import { Message } from "./message"

export const ResolveWindow = resolveWindowCommand(
	"ResolveRailwayServiceWindow",
	Message.CompletedResolveWindow,
)

/** The service's own row (limits, replicas) comes from the fleet read. */
export const FetchServices = Command.define("FetchRailwayServiceRows", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchServices],
	execute: ({ key, window }) =>
		Effect.map(loadRailwayServices(window), (result) => Message.CompletedFetchServices({ key, result })),
})

export const FetchTraced = Command.define("FetchRailwayServiceTraced", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchTraced],
	execute: ({ key, window }) =>
		Effect.map(loadTraced(window), (result) => Message.CompletedFetchTraced({ key, result })),
})

export const TimeseriesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
	serviceId: Schema.String,
	environmentId: Schema.String,
})
export type TimeseriesInput = typeof TimeseriesInput.Type

export const FetchTimeseries = Command.define("FetchRailwayServiceTimeseries", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, input }) =>
		Effect.map(loadRailwayTimeseries(input), (result) =>
			Message.CompletedFetchTimeseries({ key, result }),
		),
})

export const CompleteReloadSpin = reloadSpin("CompleteRailwayServiceReloadSpin", Message.CompletedReloadSpin)
