import { resolveWindowCommand } from "../../kit/time-frame"
import { reloadSpin, SEARCH_DEBOUNCE } from "@maple/views/data/timing"
import { Density, readLogsViewPreferences, saveLogsViewPreferences } from "@maple/views/ui/logs/viewer"
import { AttributeFilter } from "@maple/domain"
import { getCustomChartTimeSeries } from "@maple/web-data/warehouse/custom-charts"
import { getLogAttributeKeys, getLogsFacets, listLogs } from "@maple/web-data/warehouse/logs"
import { Effect, Schema, Array as Arr } from "effect"
import { Command, Mount } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { LogsSearch } from "../../../route/search"
import { loadSignalPresences } from "../../kit/signal-presence"
import { autocompleteLookup } from "../../kit/autocomplete-lookups"
import { listInput, PAGE_SIZE, toVolumeBuckets, volumeInput } from "./derive"
import { Message } from "./message"
import type { LogRowSchema, LogsPage } from "./model"

/** Snapped on entry, re-resolved against the real clock on Reload. */
export const ResolveWindow = resolveWindowCommand("ResolveLogsWindow", Message.CompletedResolveWindow)

const ListArgs = {
	key: Schema.String,
	search: LogsSearch,
	window: TimeWindow,
	pinnedNamespace: Schema.NullOr(Schema.String),
}

const page = (logs: ReadonlyArray<LogRowSchema>, cursor: string | null): LogsPage => ({ logs, cursor })

// Fetches carry their request key back so `update` drops a superseded answer.

export const FetchFirstPage = Command.define("FetchLogsFirstPage", {
	args: ListArgs,
	messages: [Message.CompletedFetchFirstPage],
	execute: ({ key, search, window, pinnedNamespace }) =>
		listLogs({ data: listInput(search, window, pinnedNamespace) }).pipe(
			Effect.map((response) => page(response.data, response.meta.cursor)),
			settleTo((result) => Message.CompletedFetchFirstPage({ key, result })),
		),
})

/** The page after `cursor`, for the first page it was started under. */
export const FetchNextPage = Command.define("FetchLogsNextPage", {
	args: { ...ListArgs, generation: Schema.Number, cursor: Schema.String },
	messages: [Message.CompletedFetchNextPage],
	execute: ({ key, search, window, pinnedNamespace, generation, cursor }) =>
		listLogs({ data: { ...listInput(search, window, pinnedNamespace), cursor, limit: PAGE_SIZE } }).pipe(
			Effect.map((response) => page(response.data, response.meta.cursor)),
			settleTo((result) => Message.CompletedFetchNextPage({ key, generation, result })),
		),
})

/** Counts within the attribute-filtered set, so they agree with the list. */
export const FetchFacets = Command.define("FetchLogsFacets", {
	args: {
		key: Schema.String,
		window: TimeWindow,
		attributeFilters: Schema.optional(Schema.Array(AttributeFilter)),
		resourceAttributeFilters: Schema.optional(Schema.Array(AttributeFilter)),
		pinnedNamespace: Schema.NullOr(Schema.String),
	},
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window, attributeFilters, resourceAttributeFilters, pinnedNamespace }) =>
		getLogsFacets({
			data: {
				startTime: window.startTime,
				endTime: window.endTime,
				namespaces: pinnedNamespace === null ? undefined : [pinnedNamespace],
				attributeFilters,
				resourceAttributeFilters,
			},
		}).pipe(
			Effect.map((response) => response.data),
			settleTo((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const FetchVolume = Command.define("FetchLogsVolume", {
	args: { ...ListArgs, bucketSeconds: Schema.Number },
	messages: [Message.CompletedFetchVolume],
	execute: ({ key, search, window, pinnedNamespace, bucketSeconds }) =>
		getCustomChartTimeSeries({ data: volumeInput(search, window, bucketSeconds, pinnedNamespace) }).pipe(
			Effect.map((response) => toVolumeBuckets(response.data)),
			settleTo((result) => Message.CompletedFetchVolume({ key, result })),
		),
})

/** What the Columns picker offers. */
export const FetchAttributeKeys = Command.define("FetchLogAttributeKeys", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchAttributeKeys],
	execute: ({ key, window }) =>
		getLogAttributeKeys({ data: window }).pipe(
			Effect.map((response) =>
				Arr.map(response.data, (row) => ({ name: row.attributeKey, count: row.usageCount })),
			),
			settleTo((result) => Message.CompletedFetchAttributeKeys({ key, result })),
		),
})

/** The advanced filter's `resource.*` key suggestions over the list's window. */
export const FetchResourceKeys = Command.define("FetchLogsResourceKeys", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchResourceKeys],
	execute: ({ key, window }) =>
		autocompleteLookup("resourceAttributeKeys", window).pipe(
			settleTo((result) => Message.CompletedFetchResourceKeys({ key, result })),
		),
})

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

export const CompleteReloadSpin = reloadSpin("CompleteLogsReloadSpin", Message.CompletedReloadSpin)

export const WaitSearchDebounce = Command.define("WaitLogsSearchDebounce", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(SEARCH_DEBOUNCE), Message.ElapsedSearchDebounce({ generation })),
})

/** The filter rail is in the DOM (its facets read as it renders, so no paint wait). */
export const MountFilterRail = Mount.define("MountLogsFilterRail", {
	messages: [Message.MountedFilterRail],
	execute: () => Effect.succeed(Message.MountedFilterRail()),
})

/** Sent when the empty state mounts (never with the data). */
export const LoadSignalPresence = Command.define("LoadLogsSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})
