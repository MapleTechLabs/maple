import { resolveWindowCommand } from "../../../kit/time-frame"
import { reloadSpin } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { TimeWindow } from "../../../../data/time-range"
import {
	loadSupabaseFleetInsights,
	loadSupabaseLogIssues,
	loadSupabaseProjects,
	loadSupabaseStatus,
} from "../data"
import { Message } from "./message"

export const ResolveWindow = resolveWindowCommand("ResolveSupabaseWindow", Message.CompletedResolveWindow)

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

export const CompleteReloadSpin = reloadSpin("CompleteSupabaseReloadSpin", Message.CompletedReloadSpin)
