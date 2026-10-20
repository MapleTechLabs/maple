import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow } from "../../../../data/time-range"
import {
	loadPlatform,
	loadStatus,
	loadUsage,
	loadWorkers,
	loadZones,
	loadZoneTimeseries,
	TimeseriesInput,
	WindowInput,
} from "../data"
import { Message, RequestMode } from "./model"

export const ResolveWindow = Command.define("ResolveCloudflareWindow", {
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

export const LoadStatus = Command.define("LoadCloudflareIngestStatus", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key, refresh }) =>
		Effect.map(loadStatus(refresh), (result) => Message.CompletedLoadStatus({ key, result })),
})

export const LoadUsage = Command.define("LoadCloudflareUsage", {
	args: { key: Schema.String },
	messages: [Message.CompletedLoadUsage],
	execute: ({ key }) => Effect.map(loadUsage(), (result) => Message.CompletedLoadUsage({ key, result })),
})

export const FetchZones = Command.define("FetchCloudflareZones", {
	args: { key: Schema.String, input: WindowInput },
	messages: [Message.CompletedFetchZones],
	execute: ({ key, input }) =>
		Effect.map(loadZones(input), (result) => Message.CompletedFetchZones({ key, result })),
})

export const FetchTimeseries = Command.define("FetchCloudflareZoneTimeseries", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, input }) =>
		Effect.map(loadZoneTimeseries(input), (result) => Message.CompletedFetchTimeseries({ key, result })),
})

export const FetchWorkers = Command.define("FetchCloudflareWorkers", {
	args: { key: Schema.String, input: WindowInput },
	messages: [Message.CompletedFetchWorkers],
	execute: ({ key, input }) =>
		Effect.map(loadWorkers(input), (result) => Message.CompletedFetchWorkers({ key, result })),
})

export const FetchPlatform = Command.define("FetchCloudflarePlatformResources", {
	args: { key: Schema.String, input: WindowInput },
	messages: [Message.CompletedFetchPlatform],
	execute: ({ key, input }) =>
		Effect.map(loadPlatform(input), (result) => Message.CompletedFetchPlatform({ key, result })),
})

export const CompleteReloadSpin = Command.define("CompleteCloudflareReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
