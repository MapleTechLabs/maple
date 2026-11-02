import { Density, readLogsViewPreferences, saveLogsViewPreferences } from "@maple/views/ui/logs/viewer"
import { logAttributeQueryFilters } from "@maple/views/lib/log-attribute-filters"
import { getCustomChartTimeSeries } from "@maple/web-data/warehouse/custom-charts"
import { getLogAttributeKeys, getLogsFacets, listLogs } from "@maple/web-data/warehouse/logs"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { LogsSearch } from "../../../route/search"
import { loadSignalPresences } from "../../kit/signal-presence"
import { listInput, PAGE_SIZE, toVolumeBuckets, volumeInput } from "./derive"
import { Message, RequestMode } from "./message"
import type { LogRowSchema, LogsPage } from "./model"

/** `useEffectiveTimeRange`: snapped on entry, re-resolved against the real clock on Reload. */
export const ResolveWindow = Command.define("ResolveLogsWindow", {
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

const ListArgs = {
	key: Schema.String,
	search: LogsSearch,
	window: TimeWindow,
	pinnedNamespace: Schema.NullOr(Schema.String),
}

const page = (logs: ReadonlyArray<LogRowSchema>, cursor: string | null): LogsPage => ({ logs, cursor })

// Fetches carry their request key back so `update` drops a superseded answer (S6).

/** `listLogsResultAtom`: the first page. */
export const FetchFirstPage = Command.define("FetchLogsFirstPage", {
	args: ListArgs,
	messages: [Message.CompletedFetchFirstPage],
	execute: ({ key, search, window, pinnedNamespace }) =>
		listLogs({ data: listInput(search, window, pinnedNamespace) }).pipe(
			Effect.mapBoth({
				onSuccess: (response) => page(response.data, response.meta.cursor),
				onFailure: toLoadFailure,
			}),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFirstPage({ key, result })),
		),
})

/** `fetchNextPage`: the page after `cursor`, for the first page it was started under. */
export const FetchNextPage = Command.define("FetchLogsNextPage", {
	args: { ...ListArgs, generation: Schema.Number, cursor: Schema.String },
	messages: [Message.CompletedFetchNextPage],
	execute: ({ key, search, window, pinnedNamespace, generation, cursor }) =>
		listLogs({ data: { ...listInput(search, window, pinnedNamespace), cursor, limit: PAGE_SIZE } }).pipe(
			Effect.mapBoth({
				onSuccess: (response) => page(response.data, response.meta.cursor),
				onFailure: toLoadFailure,
			}),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchNextPage({ key, generation, result })),
		),
})

/** `getLogsFacetsResultAtom`: counts within the attribute-filtered set, so they agree with the list. */
export const FetchFacets = Command.define("FetchLogsFacets", {
	args: {
		key: Schema.String,
		window: TimeWindow,
		attrs: Schema.optional(Schema.Array(Schema.String)),
		pinnedNamespace: Schema.NullOr(Schema.String),
	},
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window, attrs, pinnedNamespace }) =>
		getLogsFacets({
			data: {
				startTime: window.startTime,
				endTime: window.endTime,
				namespaces: pinnedNamespace === null ? undefined : [pinnedNamespace],
				...logAttributeQueryFilters(attrs),
			},
		}).pipe(
			Effect.mapBoth({ onSuccess: (response) => response.data, onFailure: toLoadFailure }),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

/** `getCustomChartTimeSeriesResultAtom` for the stacked severity histogram. */
export const FetchVolume = Command.define("FetchLogsVolume", {
	args: { ...ListArgs, bucketSeconds: Schema.Number },
	messages: [Message.CompletedFetchVolume],
	execute: ({ key, search, window, pinnedNamespace, bucketSeconds }) =>
		getCustomChartTimeSeries({ data: volumeInput(search, window, bucketSeconds, pinnedNamespace) }).pipe(
			Effect.mapBoth({
				onSuccess: (response) => toVolumeBuckets(response.data),
				onFailure: toLoadFailure,
			}),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchVolume({ key, result })),
		),
})

/** `getLogAttributeKeysResultAtom`: what the Columns picker offers. */
export const FetchAttributeKeys = Command.define("FetchLogAttributeKeys", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchAttributeKeys],
	execute: ({ key, window }) =>
		getLogAttributeKeys({ data: window }).pipe(
			Effect.mapBoth({
				onSuccess: (response) =>
					response.data.map((row) => ({ name: row.attributeKey, count: row.usageCount })),
				onFailure: toLoadFailure,
			}),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAttributeKeys({ key, result })),
		),
})

// PREFERENCES

/** The view preferences and the number locale, read on entry. */
export const ReadPreferences = Command.define("ReadLogsPreferences", {
	messages: [Message.CompletedReadPreferences],
	execute: Effect.map(readLogsViewPreferences, (preferences) =>
		Message.CompletedReadPreferences({ ...preferences, locale: navigator.language }),
	),
})

export const SavePreferences = Command.define("SaveLogsPreferences", {
	args: { wrap: Schema.Boolean, density: Density },
	messages: [Message.CompletedSavePreference],
	execute: (preferences) =>
		Effect.as(saveLogsViewPreferences(preferences), Message.CompletedSavePreference()),
})

/** `PageRefreshProvider` keeps Reload busy this long. */
export const CompleteReloadSpin = Command.define("CompleteLogsReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

/** `useDebouncedCallback(..., 300)` on the search box. */
export const WaitSearchDebounce = Command.define("WaitLogsSearchDebounce", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ generation })),
})

/** The filter rail is in the DOM (its facets read as it renders, so no paint wait). */
export const MountFilterRail = Mount.define("MountLogsFilterRail", {
	messages: [Message.MountedFilterRail],
	execute: () => Effect.succeed(Message.MountedFilterRail()),
})

/** `useSignalPresence`, sent when the empty state mounts (never with the data). */
export const LoadSignalPresence = Command.define("LoadLogsSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})
