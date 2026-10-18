import { Clock, Duration, Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { resolveWindow } from "../../../../data/time-range"
import { linkedCursorStream } from "../../../../charts/linked-cursor"
import {
	BreakdownInput,
	loadFilteredZones,
	loadStatus,
	loadTopTraffic,
	loadUsage,
	loadZoneBreakdown,
	loadZoneDetail,
	loadZoneDns,
	loadZoneFacets,
	loadZoneSecurity,
	TopTrafficInput,
	ZoneDetailInput,
	ZoneFacetsInput,
	ZonesInput,
} from "../data"
import { Message, RequestMode } from "./model"

export const ResolveWindow = Command.define("ResolveCloudflareZoneWindow", {
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

export const LoadStatus = Command.define("LoadCloudflareZoneStatus", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key, refresh }) =>
		Effect.map(loadStatus(refresh), (result) => Message.CompletedLoadStatus({ key, result })),
})

export const LoadUsage = Command.define("LoadCloudflareZoneUsage", {
	args: { key: Schema.String },
	messages: [Message.CompletedLoadUsage],
	execute: ({ key }) => Effect.map(loadUsage(), (result) => Message.CompletedLoadUsage({ key, result })),
})

export const FetchDetail = Command.define("FetchCloudflareZoneDetail", {
	args: { key: Schema.String, input: ZoneDetailInput },
	messages: [Message.CompletedFetchDetail],
	execute: ({ key, input }) =>
		Effect.map(loadZoneDetail(input), (result) => Message.CompletedFetchDetail({ key, result })),
})

export const FetchDns = Command.define("FetchCloudflareZoneDns", {
	args: { key: Schema.String, input: ZoneDetailInput },
	messages: [Message.CompletedFetchDns],
	execute: ({ key, input }) =>
		Effect.map(loadZoneDns(input), (result) => Message.CompletedFetchDns({ key, result })),
})

export const FetchSecurity = Command.define("FetchCloudflareZoneSecurity", {
	args: { key: Schema.String, input: ZoneDetailInput },
	messages: [Message.CompletedFetchSecurity],
	execute: ({ key, input }) =>
		Effect.map(loadZoneSecurity(input), (result) => Message.CompletedFetchSecurity({ key, result })),
})

export const FetchFacets = Command.define("FetchCloudflareZoneFacets", {
	args: { key: Schema.String, input: ZoneFacetsInput },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, input }) =>
		Effect.map(loadZoneFacets(input), (result) => Message.CompletedFetchFacets({ key, result })),
})

export const FetchZones = Command.define("FetchCloudflareZoneRollup", {
	args: { key: Schema.String, input: ZonesInput },
	messages: [Message.CompletedFetchZones],
	execute: ({ key, input }) =>
		Effect.map(loadFilteredZones(input), (result) => Message.CompletedFetchZones({ key, result })),
})

export const FetchBreakdown = Command.define("FetchCloudflareZoneBreakdown", {
	args: { key: Schema.String, input: BreakdownInput },
	messages: [Message.CompletedFetchBreakdown],
	execute: ({ key, input }) =>
		Effect.map(loadZoneBreakdown(input), (result) => Message.CompletedFetchBreakdown({ key, result })),
})

export const FetchLiveTraffic = Command.define("FetchCloudflareTopTraffic", {
	args: { key: Schema.String, input: TopTrafficInput },
	messages: [Message.CompletedFetchLiveTraffic],
	execute: ({ key, input }) =>
		Effect.map(loadTopTraffic(input), (result) => Message.CompletedFetchLiveTraffic({ key, result })),
})

export const CompleteReloadSpin = Command.define("CompleteCloudflareZoneReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

/** `useLinkedCursor` on the signal strips. */
export const MountLinkedCursor = Mount.defineStream("MountCloudflareZoneLinkedCursor", {
	messages: [Message.AttachedLinkedCursor],
	execute: ({ element }) => linkedCursorStream(element, Message.AttachedLinkedCursor()),
})
