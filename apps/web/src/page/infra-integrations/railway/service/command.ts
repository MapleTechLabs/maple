import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import { loadTraced } from "../../kit/traced"
import { loadRailwayServices, loadRailwayTimeseries } from "../data"
import { Message, RequestMode } from "./message"

export const ResolveWindow = Command.define("ResolveRailwayServiceWindow", {
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

/** `railwayServicesResultAtom`: the service's own row (limits, replicas) comes from the fleet read. */
export const FetchServices = Command.define("FetchRailwayServiceRows", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchServices],
	execute: ({ key, window }) =>
		Effect.map(loadRailwayServices(window), (result) => Message.CompletedFetchServices({ key, result })),
})

export const FetchTraced = Command.define("FetchRailwayServiceTraced", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchTraced],
	execute: ({ key, window }) =>
		Effect.map(loadTraced(window), (result) => Message.CompletedFetchTraced({ key, result })),
})

export const TimeseriesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
	serviceId: Schema.String,
	environmentId: Schema.String,
})
export type TimeseriesInput = typeof TimeseriesInput.Type

/** `railwayServiceTimeseriesResultAtom`. */
export const FetchTimeseries = Command.define("FetchRailwayServiceTimeseries", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, input }) =>
		Effect.map(loadRailwayTimeseries(input), (result) =>
			Message.CompletedFetchTimeseries({ key, result }),
		),
})

const RELOAD_SPIN = Duration.millis(600)

export const CompleteReloadSpin = Command.define("CompleteRailwayServiceReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), Message.CompletedReloadSpin({ version })),
})
