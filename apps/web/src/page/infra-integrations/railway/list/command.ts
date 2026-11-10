import { resolveWindowCommand } from "../../../kit/time-frame"
import { reloadSpin } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { TimeWindow } from "../../../../data/time-range"
import { loadRailwayServices, loadRailwayStatus } from "../data"
import { Message } from "./message"

export const ResolveWindow = resolveWindowCommand("ResolveRailwayWindow", Message.CompletedResolveWindow)

/** Shared with the other Railway pages through `IntegrationStatuses`. */
export const LoadStatus = Command.define("LoadRailwayStatus", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key, refresh }) =>
		Effect.map(loadRailwayStatus(refresh), (result) => Message.CompletedLoadStatus({ key, result })),
})

export const FetchServices = Command.define("FetchRailwayServices", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchServices],
	execute: ({ key, window }) =>
		Effect.map(loadRailwayServices(window), (result) => Message.CompletedFetchServices({ key, result })),
})

export const CompleteReloadSpin = reloadSpin("CompleteRailwayReloadSpin", Message.CompletedReloadSpin)
