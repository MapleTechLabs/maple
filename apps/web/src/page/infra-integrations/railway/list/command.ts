import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import { loadRailwayServices, loadRailwayStatus } from "../data"
import { Message, RequestMode } from "./message"

export const ResolveWindow = Command.define("ResolveRailwayWindow", {
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

/** `railwayStatusAtom`, shared with the sidebar through `IntegrationStatuses`. */
export const LoadStatus = Command.define("LoadRailwayStatus", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key, refresh }) =>
		Effect.map(loadRailwayStatus(refresh), (result) => Message.CompletedLoadStatus({ key, result })),
})

/** `railwayServicesResultAtom({ data: window })`. */
export const FetchServices = Command.define("FetchRailwayServices", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchServices],
	execute: ({ key, window }) =>
		Effect.map(loadRailwayServices(window), (result) => Message.CompletedFetchServices({ key, result })),
})

const RELOAD_SPIN = Duration.millis(600)

export const CompleteReloadSpin = Command.define("CompleteRailwayReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), Message.CompletedReloadSpin({ version })),
})
