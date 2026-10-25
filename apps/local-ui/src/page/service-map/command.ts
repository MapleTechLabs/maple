import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Snapshot, ViewPrefs } from "@maple/web/service-map/map/state"
import { Clock, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { withCache } from "../../data/cached"
import { mapFromCached } from "./data"
import { fetchServiceMap } from "./fetch"
import { Message } from "./message"

// The map query, the clock reads and the per-browser storage of lib/service-map-state.ts.

const LAYOUT_KEY = "maple-local:service-map.layout"
const VIEW_PREFS_KEY = "maple-local:service-map.view-prefs"

const LayoutJson = Schema.fromJsonString(Schema.Struct({ snapshots: Schema.Array(Snapshot) }))
const PrefsJson = Schema.fromJsonString(ViewPrefs)

export const ReadClock = Command.define("ReadServiceMapClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadServiceMapRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

/** Undecodable entries fall back to the defaults, as `storedValue` does. */
export const ReadStored = Command.define("ReadLocalServiceMapStored", {
	messages: [Message.CompletedReadStored],
	execute: Effect.sync(() =>
		Message.CompletedReadStored({
			stored: {
				prefs: Option.getOrElse(
					Option.flatMap(readLocalStorage(VIEW_PREFS_KEY), Schema.decodeUnknownOption(PrefsJson)),
					() => ({ minTrafficPct: 0, collapsedNamespaces: [] }),
				),
				snapshots: Option.match(
					Option.flatMap(readLocalStorage(LAYOUT_KEY), Schema.decodeUnknownOption(LayoutJson)),
					{ onNone: () => [], onSome: (layout) => layout.snapshots },
				),
			},
		}),
	),
})

export const SaveLayout = Command.define("SaveLocalServiceMapLayout", {
	args: { snapshots: Schema.Array(Snapshot) },
	messages: [Message.CompletedSaveLayout],
	execute: ({ snapshots }) =>
		Effect.sync(() => {
			writeLocalStorage(LAYOUT_KEY, JSON.stringify({ snapshots }))
			return Message.CompletedSaveLayout()
		}),
})

export const SaveViewPrefs = Command.define("SaveLocalServiceMapViewPrefs", {
	args: { prefs: ViewPrefs },
	messages: [Message.CompletedSaveViewPrefs],
	execute: ({ prefs }) =>
		Effect.sync(() => {
			writeLocalStorage(VIEW_PREFS_KEY, JSON.stringify(prefs))
			return Message.CompletedSaveViewPrefs()
		}),
})

/** `useLocalServiceMap`: `windowed(["local", "service-map", durationSeconds, boundsKey(bounds)])`. */
export const FetchServiceMap = Command.define("FetchLocalServiceMap", {
	args: {
		key: Schema.String,
		startTime: Schema.String,
		endTime: Schema.String,
		durationSeconds: Schema.Number,
		apiBase: Schema.String,
		readsCache: Schema.Boolean,
	},
	messages: [Message.SucceededFetchServiceMap, Message.FailedFetchServiceMap, Message.FoundCachedServiceMap],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, startTime, endTime, durationSeconds, apiBase, readsCache }) =>
		withCache({
			key: ["local", "service-map", durationSeconds, `${startTime}/${endTime}`],
			readsCache,
			fromCached: mapFromCached,
			toCached: (data) => data,
			fetch: fetchServiceMap({ startTime, endTime }, durationSeconds, apiBase),
			found: (cached) => Message.FoundCachedServiceMap({ key, cached }),
			succeeded: (data, fetchedAtMs) => Message.SucceededFetchServiceMap({ key, data, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchServiceMap({ key, failure })))),
})
