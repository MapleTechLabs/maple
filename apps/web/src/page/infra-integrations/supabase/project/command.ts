import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import {
	loadSupabaseApiTopPaths,
	loadSupabaseApiTraffic,
	loadSupabaseCallers,
	loadSupabaseInsights,
	loadSupabaseLogIssues,
	loadSupabaseProjects,
	loadSupabaseStatus,
	loadSupabaseTimeseries,
} from "../data"
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

/** The project's name, region, lifecycle status and switches come from discovery. */
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

export const ProjectWindowInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	projectRef: Schema.String,
})
export type ProjectWindowInput = typeof ProjectWindowInput.Type

export const TimeseriesInput = Schema.Struct({ ...ProjectWindowInput.fields, bucketSeconds: Schema.Number })
export type TimeseriesInput = typeof TimeseriesInput.Type

export const FetchTimeseries = Command.define("FetchSupabaseProjectTimeseries", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, input }) =>
		Effect.map(loadSupabaseTimeseries(input), (result) =>
			Message.CompletedFetchTimeseries({ key, result }),
		),
})

export const FetchTraffic = Command.define("FetchSupabaseApiTraffic", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchTraffic],
	execute: ({ key, input }) =>
		Effect.map(loadSupabaseApiTraffic(input), (result) => Message.CompletedFetchTraffic({ key, result })),
})

export const FetchTopPaths = Command.define("FetchSupabaseApiTopPaths", {
	args: { key: Schema.String, input: ProjectWindowInput },
	messages: [Message.CompletedFetchTopPaths],
	execute: ({ key, input }) =>
		Effect.map(loadSupabaseApiTopPaths(input), (result) =>
			Message.CompletedFetchTopPaths({ key, result }),
		),
})

export const FetchCallers = Command.define("FetchSupabaseProjectCallers", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchCallers],
	execute: ({ key, input }) =>
		Effect.map(loadSupabaseCallers(input), (result) => Message.CompletedFetchCallers({ key, result })),
})

export const FetchIssues = Command.define("FetchSupabaseProjectLogIssues", {
	args: { key: Schema.String, input: ProjectWindowInput },
	messages: [Message.CompletedFetchIssues],
	execute: ({ key, input }) =>
		Effect.map(loadSupabaseLogIssues(input), (result) => Message.CompletedFetchIssues({ key, result })),
})

export const FetchInsights = Command.define("FetchSupabaseProjectInsights", {
	args: { key: Schema.String, projectRef: Schema.String },
	messages: [Message.CompletedFetchInsights],
	execute: ({ key, projectRef }) =>
		Effect.map(loadSupabaseInsights(projectRef), (result) =>
			Message.CompletedFetchInsights({ key, result }),
		),
})

const RELOAD_SPIN = Duration.millis(600)

export const CompleteReloadSpin = Command.define("CompleteSupabaseProjectReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), Message.CompletedReloadSpin({ version })),
})
