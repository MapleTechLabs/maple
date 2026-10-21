import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import {
	loadSupabaseFleetInsights,
	loadSupabaseLogIssues,
	loadSupabaseProjects,
	loadSupabaseStatus,
} from "../data"
import { Message, RequestMode } from "./message"

export const ResolveWindow = Command.define("ResolveSupabaseWindow", {
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

/** Shared with the sidebar and the integration card through `IntegrationStatuses`. */
export const LoadStatus = Command.define("LoadInfraSupabaseStatus", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key, refresh }) =>
		Effect.map(loadSupabaseStatus(refresh), (result) => Message.CompletedLoadStatus({ key, result })),
})

export const FetchProjects = Command.define("FetchSupabaseProjects", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchProjects],
	execute: ({ key, window }) =>
		Effect.map(loadSupabaseProjects(window), (result) => Message.CompletedFetchProjects({ key, result })),
})

export const FetchIssues = Command.define("FetchSupabaseFleetIssues", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchIssues],
	execute: ({ key, window }) =>
		Effect.map(loadSupabaseLogIssues(window), (result) => Message.CompletedFetchIssues({ key, result })),
})

/** Never fails: a project whose advisors fail to read is listed in `failedRefs`. */
export const FetchInsights = Command.define("FetchSupabaseFleetInsights", {
	args: { key: Schema.String, refs: Schema.Array(Schema.String) },
	messages: [Message.CompletedFetchInsights],
	execute: ({ key, refs }) =>
		Effect.map(loadSupabaseFleetInsights(refs), (insights) =>
			Message.CompletedFetchInsights({ key, insights }),
		),
})

const RELOAD_SPIN = Duration.millis(600)

export const CompleteReloadSpin = Command.define("CompleteSupabaseReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), Message.CompletedReloadSpin({ version })),
})
