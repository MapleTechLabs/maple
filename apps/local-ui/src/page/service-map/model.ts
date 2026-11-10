import * as ServiceMap from "@maple/views/service-map/map/service-map"
import { Stored } from "@maple/views/service-map/map/state"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { Copies } from "../kit/copies"
import { LocalServiceMapData } from "./data"

// The service map page.

export const Model = Schema.TaggedStruct("ServiceMapPage", {
	/** The time window's anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	nowMs: Schema.Number,
	data: KeyedSchema(LocalServiceMapData, LoadFailure),
	/** When the map query last loaded, for the "New data" pill. */
	dataUpdatedAtMs: Schema.Number,
	/** localStorage read on entry; the map is built once it and the rows are in. */
	maybeStored: Schema.Option(Stored),
	maybeMap: Schema.Option(ServiceMap.Model),
	isRefreshing: Schema.Boolean,
	copies: Copies,
})
export type Model = typeof Model.Type
