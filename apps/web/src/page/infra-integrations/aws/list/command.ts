import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import { loadFleet, loadSparks, loadStatus, loadTraced, SparksInput } from "../data"
import { Message, RequestMode } from "./message"

export const ResolveWindow = Command.define("ResolveAwsWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

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

export const CompleteReloadSpin = Command.define("CompleteAwsReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
