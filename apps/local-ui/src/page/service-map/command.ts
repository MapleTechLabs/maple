import { readClock } from "@maple/views/data/timing"
import {
	readStored,
	saveStoredLayout,
	saveStoredPrefs,
	Snapshot,
	type StoredKeys,
	ViewPrefs,
} from "@maple/views/service-map/map/state"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { withCache } from "../../data/cached"
import { mapFromCached } from "./data"
import { fetchServiceMap } from "./fetch"
import { Message } from "./message"

// The map query, the clock reads and the map's per-browser storage.

const STORED_KEYS: StoredKeys = {
	layout: "maple-local:service-map.layout",
	prefs: "maple-local:service-map.view-prefs",
}

export const ReadClock = readClock("ReadServiceMapClock", Message.CompletedReadClock)

export const ReadRefreshClock = readClock("ReadServiceMapRefreshClock", Message.CompletedReadRefreshClock)

/** Undecodable entries fall back to the defaults. */
export const ReadStored = Command.define("ReadLocalServiceMapStored", {
	messages: [Message.CompletedReadStored],
	execute: Effect.sync(() => Message.CompletedReadStored({ stored: readStored(STORED_KEYS) })),
})

export const SaveLayout = Command.define("SaveLocalServiceMapLayout", {
	args: { snapshots: Schema.Array(Snapshot) },
	messages: [Message.CompletedSaveLayout],
	execute: ({ snapshots }) =>
		Effect.as(saveStoredLayout(STORED_KEYS, snapshots), Message.CompletedSaveLayout()),
})

export const SaveViewPrefs = Command.define("SaveLocalServiceMapViewPrefs", {
	args: { prefs: ViewPrefs },
	messages: [Message.CompletedSaveViewPrefs],
	execute: ({ prefs }) => Effect.as(saveStoredPrefs(STORED_KEYS, prefs), Message.CompletedSaveViewPrefs()),
})

/** The map query, cached under `["local", "service-map", durationSeconds, boundsKey(bounds)]`. */
export const FetchServiceMap = Command.define("FetchLocalServiceMap", {
	args: {
		key: Schema.String,
		startTime: Schema.String,
		endTime: Schema.String,
		durationSeconds: Schema.Number,
		apiBase: Schema.String,
		readsCache: Schema.Boolean,
	},
	messages: [
		Message.SucceededFetchServiceMap,
		Message.FailedFetchServiceMap,
		Message.FoundCachedServiceMap,
	],
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
