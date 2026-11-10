import { resolveWindowCommand } from "../../../kit/time-frame"
import { reloadSpin } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { TimeWindow } from "../../../../data/time-range"
import { loadTraced } from "../../kit/traced"
import { loadFleet, loadSparks, loadStatus, SparksInput } from "../data"
import { Message } from "./message"

export const ResolveWindow = resolveWindowCommand("ResolveAwsWindow", Message.CompletedResolveWindow)

export const LoadStatus = Command.define("LoadInfraAwsStatus", {
	args: { key: Schema.String },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key }) => Effect.map(loadStatus, (result) => Message.CompletedLoadStatus({ key, result })),
})

export const FetchFleet = Command.define("FetchAwsFleet", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFleet],
	execute: ({ key, window }) =>
		Effect.map(loadFleet(window), (result) => Message.CompletedFetchFleet({ key, result })),
})

export const FetchSparks = Command.define("FetchAwsSparklines", {
	args: { key: Schema.String, input: SparksInput },
	messages: [Message.CompletedFetchSparks],
	execute: ({ key, input }) =>
		Effect.map(loadSparks(input), (result) => Message.CompletedFetchSparks({ key, result })),
})

export const FetchTraced = Command.define("FetchAwsTracedServices", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchTraced],
	execute: ({ key, window }) =>
		Effect.map(loadTraced(window), (result) => Message.CompletedFetchTraced({ key, result })),
})

export const CompleteReloadSpin = reloadSpin("CompleteAwsReloadSpin", Message.CompletedReloadSpin)
