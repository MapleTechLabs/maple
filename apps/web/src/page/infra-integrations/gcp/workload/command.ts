import { Clock, Duration, Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import { linkedCursorStream } from "../../../../charts/linked-cursor"
import {
	CloudSqlInput,
	loadFleet,
	loadOverview,
	loadStatementSpans,
	loadResources,
	loadTimeseries,
	loadTopQueries,
	loadTraceSide,
	OverviewInput,
	ResourcesQuery,
	StatementSpansInput,
	TimeseriesInput,
} from "../data"
import { Message, RequestMode } from "./model"

export const ResolveWindow = Command.define("ResolveGcpWorkloadWindow", {
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

export const FetchTimeseries = Command.define("FetchGcpWorkloadTimeseries", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, input }) =>
		Effect.map(loadTimeseries(input), (result) => Message.CompletedFetchTimeseries({ key, result })),
})

export const FetchNodes = Command.define("FetchGcpClusterNodes", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedFetchNodes],
	execute: ({ key, input }) =>
		Effect.map(loadTimeseries(input), (result) => Message.CompletedFetchNodes({ key, result })),
})

export const FetchResource = Command.define("FetchGcpWorkloadResource", {
	args: { key: Schema.String, query: ResourcesQuery },
	messages: [Message.CompletedFetchResource],
	execute: ({ key, query }) =>
		Effect.map(loadResources(query), (result) => Message.CompletedFetchResource({ key, result })),
})

export const FetchSqlInventory = Command.define("FetchGcpWorkloadSqlInventory", {
	args: { key: Schema.String, query: ResourcesQuery },
	messages: [Message.CompletedFetchSqlInventory],
	execute: ({ key, query }) =>
		Effect.map(loadResources(query), (result) => Message.CompletedFetchSqlInventory({ key, result })),
})

export const FetchOverview = Command.define("FetchGcpWorkloadServiceOverview", {
	args: { key: Schema.String, input: OverviewInput },
	messages: [Message.CompletedFetchOverview],
	execute: ({ key, input }) =>
		Effect.map(loadOverview(input), (result) => Message.CompletedFetchOverview({ key, result })),
})

export const FetchTopQueries = Command.define("FetchGcpCloudSqlTopQueries", {
	args: { key: Schema.String, input: CloudSqlInput },
	messages: [Message.CompletedFetchTopQueries],
	execute: ({ key, input }) =>
		Effect.map(loadTopQueries(input), (result) => Message.CompletedFetchTopQueries({ key, result })),
})

export const FetchTraceSide = Command.define("FetchGcpCloudSqlTraceSide", {
	args: { key: Schema.String, input: CloudSqlInput },
	messages: [Message.CompletedFetchTraceSide],
	execute: ({ key, input }) =>
		Effect.map(loadTraceSide(input), (result) => Message.CompletedFetchTraceSide({ key, result })),
})

export const FetchStatementSpans = Command.define("FetchGcpCloudSqlStatementSpans", {
	args: { key: Schema.String, input: StatementSpansInput },
	messages: [Message.CompletedFetchStatementSpans],
	execute: ({ key, input }) =>
		Effect.map(loadStatementSpans(input), (result) =>
			Message.CompletedFetchStatementSpans({ key, result }),
		),
})

export const FetchFleet = Command.define("FetchGcpWorkloadFleet", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFleet],
	execute: ({ key, window }) =>
		Effect.map(loadFleet(window), (result) => Message.CompletedFetchFleet({ key, result })),
})

export const CompleteReloadSpin = Command.define("CompleteGcpWorkloadReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

/** `useLinkedCursor` on a group of charts. */
export const MountLinkedCursor = Mount.defineStream("MountGcpLinkedCursor", {
	messages: [Message.AttachedLinkedCursor],
	execute: ({ element }) => linkedCursorStream(element, Message.AttachedLinkedCursor()),
})
