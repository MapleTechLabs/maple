import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import { loadFleet, loadResources, loadSparks, loadStatus, ResourcesQuery, SparksInput } from "../data"
import { readLocale } from "../../../kit/locale"
import { Message, RequestMode } from "./model"

export const ResolveWindow = Command.define("ResolveGcpWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.zipWith(Clock.currentTimeMillis, readLocale, (nowMs, locale) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				locale,
				mode,
			}),
		),
})

export const LoadStatus = Command.define("LoadGcpStatus", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key, refresh }) =>
		Effect.map(loadStatus(refresh), (result) => Message.CompletedLoadStatus({ key, result })),
})

export const FetchFleet = Command.define("FetchGcpFleet", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFleet],
	execute: ({ key, window }) =>
		Effect.map(loadFleet(window), (result) => Message.CompletedFetchFleet({ key, result })),
})

export const FetchSparks = Command.define("FetchGcpSparklines", {
	args: { key: Schema.String, input: SparksInput },
	messages: [Message.CompletedFetchSparks],
	execute: ({ key, input }) =>
		Effect.map(loadSparks(input), (result) => Message.CompletedFetchSparks({ key, result })),
})

export const FetchCloudSqlInventory = Command.define("FetchGcpCloudSqlInventory", {
	args: { key: Schema.String, query: ResourcesQuery },
	messages: [Message.CompletedFetchCloudSqlInventory],
	execute: ({ key, query }) =>
		Effect.map(loadResources(query), (result) =>
			Message.CompletedFetchCloudSqlInventory({ key, result }),
		),
})

export const FetchResources = Command.define("FetchGcpResources", {
	args: { key: Schema.String, query: ResourcesQuery },
	messages: [Message.CompletedFetchResources],
	execute: ({ key, query }) =>
		Effect.map(loadResources(query), (result) => Message.CompletedFetchResources({ key, result })),
})

export const CompleteReloadSpin = Command.define("CompleteGcpReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
