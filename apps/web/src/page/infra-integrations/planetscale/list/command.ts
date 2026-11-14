import { resolveWindowCommand } from "../../../kit/time-frame"
import { reloadSpin } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { TimeWindow } from "../../../../data/time-range"
import { loadDatabases, loadDatabaseStats, loadStatus } from "../data"
import { Message } from "./model"

export const ResolveWindow = resolveWindowCommand("ResolvePlanetscaleWindow", Message.CompletedResolveWindow)

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

export const CompleteReloadSpin = reloadSpin("CompletePlanetscaleReloadSpin", Message.CompletedReloadSpin)
