import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import {
	loadVercelAiGateway,
	loadVercelDeployments,
	loadVercelProjectDetail,
	loadVercelProjects,
	loadVercelRequestSeries,
	loadVercelStatus,
	ProjectInput,
	SeriesInput,
} from "../data"
import { Message, RequestMode } from "./model"

export const ResolveWindow = Command.define("ResolveVercelProjectWindow", {
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

export const LoadStatus = Command.define("LoadVercelProjectStatus", {
	args: { key: Schema.String },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key }) =>
		Effect.map(loadVercelStatus(), (result) => Message.CompletedLoadStatus({ key, result })),
})

export const FetchProjects = Command.define("FetchVercelProjectRows", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchProjects],
	execute: ({ key, window }) =>
		Effect.map(loadVercelProjects(window), (result) => Message.CompletedFetchProjects({ key, result })),
})

export const FetchBuckets = Command.define("FetchVercelProjectRequestSeries", {
	args: { key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchBuckets],
	execute: ({ key, input }) =>
		Effect.map(loadVercelRequestSeries(input), (result) =>
			Message.CompletedFetchBuckets({ key, result }),
		),
})

export const FetchDetail = Command.define("FetchVercelProjectDetail", {
	args: { key: Schema.String, input: ProjectInput },
	messages: [Message.CompletedFetchDetail],
	execute: ({ key, input }) =>
		Effect.map(loadVercelProjectDetail(input), (result) => Message.CompletedFetchDetail({ key, result })),
})

export const FetchDeployments = Command.define("FetchVercelDeployments", {
	args: { key: Schema.String, projectId: Schema.String },
	messages: [Message.CompletedFetchDeployments],
	execute: ({ key, projectId }) =>
		Effect.map(loadVercelDeployments(projectId), (result) =>
			Message.CompletedFetchDeployments({ key, result }),
		),
})

export const FetchAiGateway = Command.define("FetchVercelProjectAiGateway", {
	args: { key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchAiGateway],
	execute: ({ key, input }) =>
		Effect.map(loadVercelAiGateway(input), (result) => Message.CompletedFetchAiGateway({ key, result })),
})

export const CompleteReloadSpin = Command.define("CompleteVercelProjectReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
