import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import {
	loadVercelAiGateway,
	loadVercelProjects,
	loadVercelRequestSeries,
	loadVercelStatus,
	SeriesInput,
} from "../data"
import { Message, RequestMode } from "./model"

export const ResolveWindow = Command.define("ResolveVercelWindow", {
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

export const LoadStatus = Command.define("LoadVercelStatus", {
	args: { key: Schema.String },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key }) =>
		Effect.map(loadVercelStatus(), (result) => Message.CompletedLoadStatus({ key, result })),
})

export const FetchProjects = Command.define("FetchVercelProjects", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchProjects],
	execute: ({ key, window }) =>
		Effect.map(loadVercelProjects(window), (result) => Message.CompletedFetchProjects({ key, result })),
})

export const FetchBuckets = Command.define("FetchVercelRequestSeries", {
	args: { key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchBuckets],
	execute: ({ key, input }) =>
		Effect.map(loadVercelRequestSeries(input), (result) =>
			Message.CompletedFetchBuckets({ key, result }),
		),
})

export const FetchAiGateway = Command.define("FetchVercelAiGateway", {
	args: { key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchAiGateway],
	execute: ({ key, input }) =>
		Effect.map(loadVercelAiGateway(input), (result) => Message.CompletedFetchAiGateway({ key, result })),
})

export const CompleteReloadSpin = Command.define("CompleteVercelReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
