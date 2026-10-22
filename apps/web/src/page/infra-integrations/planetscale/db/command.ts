import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import {
	EpochWindowInput,
	loadBranchStats,
	loadDatabases,
	loadEvents,
	loadInsights,
	loadStatus,
	loadTimeseries,
	TimeseriesInput,
} from "../data"
import { Message, RequestMode } from "./model"

/** The window plus its bounds read as browser-local time, for the events read. */
const withLocal = (window: TimeWindow) => ({
	window,
	localWindow: { startMs: new Date(window.startTime).getTime(), endMs: new Date(window.endTime).getTime() },
})

export const ResolveWindow = Command.define("ResolvePlanetscaleDatabaseWindow", {
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
				...withLocal(
					resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				),
				nowMs,
				mode,
			}),
		),
})

export const LoadStatus = Command.define("LoadPlanetscaleDatabaseStatus", {
	args: { key: Schema.String },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key }) =>
		Effect.map(loadStatus(false), (result) => Message.CompletedLoadStatus({ key, result })),
})

export const FetchDatabases = Command.define("FetchPlanetscaleInventory", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchDatabases],
	execute: ({ key }) =>
		Effect.map(loadDatabases, (result) => Message.CompletedFetchDatabases({ key, result })),
})

export const FetchBranchStats = Command.define("FetchPlanetscaleBranchStats", {
	args: { key: Schema.String, window: TimeWindow, database: Schema.String },
	messages: [Message.CompletedFetchBranchStats],
	execute: ({ key, window, database }) =>
		Effect.map(loadBranchStats({ ...window, database }), (result) =>
			Message.CompletedFetchBranchStats({ key, result }),
		),
})

export const FetchTimeseries = Command.define("FetchPlanetscaleTimeseries", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, input }) =>
		Effect.map(loadTimeseries(input), (result) => Message.CompletedFetchTimeseries({ key, result })),
})

export const FetchEvents = Command.define("FetchPlanetscaleEvents", {
	args: { key: Schema.String, input: EpochWindowInput },
	messages: [Message.CompletedFetchEvents],
	execute: ({ key, input }) =>
		Effect.map(loadEvents(input), (result) => Message.CompletedFetchEvents({ key, result })),
})

export const FetchInsights = Command.define("FetchPlanetscaleQueryInsights", {
	args: { key: Schema.String, input: EpochWindowInput },
	messages: [Message.CompletedFetchInsights],
	execute: ({ key, input }) =>
		Effect.map(loadInsights(input), (result) => Message.CompletedFetchInsights({ key, result })),
})

export const CompleteReloadSpin = Command.define("CompletePlanetscaleDatabaseReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
