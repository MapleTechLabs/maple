import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
import { LocalServiceMapData } from "./data"
import { Stored } from "./model"

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	CompletedReadStored: { stored: Stored },
	SucceededFetchServiceMap: { key: Schema.String, data: LocalServiceMapData, fetchedAtMs: Schema.Number },
	/** The result cache held this window (or an older one standing in) before the fetch ran. */
	FoundCachedServiceMap: { key: Schema.String, cached: CachedOf(LocalServiceMapData) },
	FailedFetchServiceMap: { key: Schema.String, failure: LoadFailure },
	ClickedRefresh: {},
	ClickedRetry: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	CompletedSaveLayout: {},
	CompletedSaveViewPrefs: {},
	/** The detail panel's close button: the map clears its selection. */
	ClickedCloseDetail: {},
	/** The service panel's focus button: the map focuses the selected service. */
	ClickedFocusSelected: {},
	/** The root saw the fragment change under the open page: a new range re-keys the query. */
	InformedOfLocationChange: {},
})
export type Message = typeof Message.Type
