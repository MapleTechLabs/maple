import * as ServiceMap from "@maple/web/service-map/map/service-map"
import { Snapshot, ViewPrefs } from "@maple/web/service-map/map/state"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import { Copies } from "../kit/copies"
import { LocalServiceMapData } from "./data"

// The service map page.

/** What local mode keeps per browser (lib/service-map-state.ts): declutter prefs and layout snapshots. */
export const Stored = Schema.Struct({ prefs: ViewPrefs, snapshots: Schema.Array(Snapshot) })
export type Stored = typeof Stored.Type

export const Model = Schema.TaggedStruct("ServiceMapPage", {
	/** The time window's anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	nowMs: Schema.Number,
	data: SlotSchema(LocalServiceMapData),
	/** `dataUpdatedAt` of the map query, for the "New data" pill. */
	dataUpdatedAtMs: Schema.Number,
	/** localStorage read on entry; the map is built once it and the rows are in. */
	maybeStored: Schema.Option(Stored),
	maybeMap: Schema.Option(ServiceMap.Model),
	isRefreshing: Schema.Boolean,
	copies: Copies,
})
export type Model = typeof Model.Type
