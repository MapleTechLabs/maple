import { Clock, Duration, Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { linkedCursorStream } from "@maple/views/charts/linked-cursor"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import {
	loadVercelAiGateway,
	loadVercelAuditLog,
	loadVercelDeployments,
	loadVercelLatencySeries,
	loadVercelProjects,
	loadVercelRequestSeries,
	loadVercelSpeedInsights,
	loadVercelStatus,
	loadVercelWebAnalytics,
	SeriesInput,
	WindowInput,
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
		Effect.map(loadVercelStatus, (result) => Message.CompletedLoadStatus({ key, result })),
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

export const FetchLatency = Command.define("FetchVercelLatencySeries", {
	args: { key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchLatency],
	execute: ({ key, input }) =>
		Effect.map(loadVercelLatencySeries(input), (result) =>
			Message.CompletedFetchLatency({ key, result }),
		),
})

export const FetchAiGateway = Command.define("FetchVercelAiGateway", {
	args: { key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchAiGateway],
	execute: ({ key, input }) =>
		Effect.map(loadVercelAiGateway(input), (result) => Message.CompletedFetchAiGateway({ key, result })),
})

export const FetchDeployments = Command.define("FetchVercelTeamDeployments", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchDeployments],
	execute: ({ key }) =>
		Effect.map(loadVercelDeployments(undefined), (result) =>
			Message.CompletedFetchDeployments({ key, result }),
		),
})

export const FetchSpeedInsights = Command.define("FetchVercelSpeedInsights", {
	args: { key: Schema.String, input: WindowInput },
	messages: [Message.CompletedFetchSpeedInsights],
	execute: ({ key, input }) =>
		Effect.map(loadVercelSpeedInsights(input), (result) =>
			Message.CompletedFetchSpeedInsights({ key, result }),
		),
})

export const FetchWebAnalytics = Command.define("FetchVercelWebAnalytics", {
	args: { key: Schema.String, input: WindowInput },
	messages: [Message.CompletedFetchWebAnalytics],
	execute: ({ key, input }) =>
		Effect.map(loadVercelWebAnalytics(input), (result) =>
			Message.CompletedFetchWebAnalytics({ key, result }),
		),
})

export const FetchAuditLog = Command.define("FetchVercelAuditLog", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchAuditLog],
	execute: ({ key, window }) =>
		Effect.map(loadVercelAuditLog(window), (result) => Message.CompletedFetchAuditLog({ key, result })),
})

export const CompleteReloadSpin = Command.define("CompleteVercelReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

/** `useLinkedCursor` on the strips. */
export const MountLinkedCursor = Mount.defineStream("MountVercelLinkedCursor", {
	messages: [Message.AttachedLinkedCursor],
	execute: ({ element }) => linkedCursorStream(element, Message.AttachedLinkedCursor()),
})
