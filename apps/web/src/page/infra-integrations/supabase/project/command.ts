import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import { loadSupabaseProjects, loadSupabaseStatus, loadSupabaseTimeseries } from "../data"
import { Message, RequestMode } from "./message"

export const ResolveWindow = Command.define("ResolveSupabaseProjectWindow", {
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

/** The project's name, region and lifecycle status come from discovery. */
export const LoadStatus = Command.define("LoadSupabaseProjectStatus", {
	args: { key: Schema.String },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key }) =>
		Effect.map(loadSupabaseStatus(false), (result) => Message.CompletedLoadStatus({ key, result })),
})

/** The project's own summary row comes from the fleet read, like the list's. */
export const FetchProjects = Command.define("FetchSupabaseProjectRows", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchProjects],
	execute: ({ key, window }) =>
		Effect.map(loadSupabaseProjects(window), (result) => Message.CompletedFetchProjects({ key, result })),
})

export const TimeseriesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
	projectRef: Schema.String,
})
export type TimeseriesInput = typeof TimeseriesInput.Type

export const FetchTimeseries = Command.define("FetchSupabaseProjectTimeseries", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, input }) =>
		Effect.map(loadSupabaseTimeseries(input), (result) =>
			Message.CompletedFetchTimeseries({ key, result }),
		),
})

const RELOAD_SPIN = Duration.millis(600)

export const CompleteReloadSpin = Command.define("CompleteSupabaseProjectReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), Message.CompletedReloadSpin({ version })),
})
