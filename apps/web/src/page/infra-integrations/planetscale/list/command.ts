import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import { loadDatabases, loadDatabaseStats, loadStatus } from "../data"
import { Message, RequestMode } from "./model"

export const ResolveWindow = Command.define("ResolvePlanetscaleWindow", {
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

export const LoadStatus = Command.define("LoadPlanetscaleStatus", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key, refresh }) =>
		Effect.map(loadStatus(refresh), (result) => Message.CompletedLoadStatus({ key, result })),
})

export const FetchDatabases = Command.define("FetchPlanetscaleDatabases", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchDatabases],
	execute: ({ key }) =>
		Effect.map(loadDatabases, (result) => Message.CompletedFetchDatabases({ key, result })),
})

export const FetchStats = Command.define("FetchPlanetscaleDatabaseStats", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchStats],
	execute: ({ key, window }) =>
		Effect.map(loadDatabaseStats(window), (result) => Message.CompletedFetchStats({ key, result })),
})

export const CompleteReloadSpin = Command.define("CompletePlanetscaleReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
