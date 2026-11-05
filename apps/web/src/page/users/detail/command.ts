import { getUserActivity, getUserLogs, getUserProfile, getUserTraces } from "@maple/web-data/warehouse/users"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { IdleTtl } from "../../../data/idle-ttl"
import { readThrough } from "../../../data/read-cache"
import { TimeWindow } from "../../../data/time-range"
import { resolveUsersWindow } from "../window"
import { Message, RequestMode } from "./message"
import { ActivityData, LogsData, ProfileData, TracesData, type Search } from "./model"

/** The namespace in effect: the org-global pin wins over one picked on this page. */
export const activeNamespace = (search: Search, pinnedNamespace: string | null): string | null =>
	pinnedNamespace ?? (search.namespace === undefined || search.namespace === "" ? null : search.namespace)

/** Every read's inputs: the user, the window and the namespace scope. */
export const detailInputs = (
	userId: string,
	search: Search,
	window: TimeWindow,
	pinnedNamespace: string | null,
) => {
	const namespace = activeNamespace(search, pinnedNamespace)
	return {
		userId,
		startTime: window.startTime,
		endTime: window.endTime,
		namespaces: namespace === null ? [] : [namespace],
	}
}

export const ResolveWindow = Command.define("ResolveUserWindow", {
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
				window: resolveUsersWindow(
					{ startTime, endTime, preset, snap: mode === "Load", timeZone },
					nowMs,
				),
				nowMs,
				mode,
			}),
		),
})

const FetchArgs = {
	key: Schema.String,
	userId: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	namespaces: Schema.Array(Schema.String),
	refresh: Schema.Boolean,
}

export const FetchProfile = Command.define("FetchUserProfile", {
	args: FetchArgs,
	messages: [Message.CompletedFetchProfile],
	execute: ({ key, refresh, ...data }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.userProfile, schema: ProfileData },
			Effect.map(getUserProfile({ data }), (response): ProfileData => ({ profile: response.profile })),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchProfile({ key, result })),
		),
})

export const FetchActivity = Command.define("FetchUserActivity", {
	args: FetchArgs,
	messages: [Message.CompletedFetchActivity],
	execute: ({ key, refresh, ...data }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.userActivity, schema: ActivityData },
			Effect.map(getUserActivity({ data }), (response): ActivityData => ({
				sessions: response.sessions,
				events: response.events,
				mcpSessions: response.mcpSessions,
				activity: response.activity,
			})),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchActivity({ key, result })),
		),
})

export const FetchTraces = Command.define("FetchUserTraces", {
	args: FetchArgs,
	messages: [Message.CompletedFetchTraces],
	execute: ({ key, refresh, ...data }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.userTraces, schema: TracesData },
			Effect.map(getUserTraces({ data }), (response): TracesData => ({ traces: response.traces })),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTraces({ key, result })),
		),
})

export const FetchLogs = Command.define("FetchUserLogs", {
	args: FetchArgs,
	messages: [Message.CompletedFetchLogs],
	execute: ({ key, refresh, ...data }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.userLogs, schema: LogsData },
			Effect.map(getUserLogs({ data }), (response): LogsData => ({ logs: response.logs })),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchLogs({ key, result })),
		),
})

export const CompleteReloadSpin = Command.define("CompleteUserReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
