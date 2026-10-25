import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import { Copies } from "../kit/copies"
import { ErrorsFacets, ErrorsSummary, ErrorTrace, ErrorTypeRow } from "./fetch"

/** One `ErrorTypeCard`'s own state: open or not, and its traces query (kept while closed). */
export const Card = Schema.Struct({
	isExpanded: Schema.Boolean,
	traces: SlotSchema(Schema.Array(ErrorTrace)),
})
export type Card = typeof Card.Type

export const Model = Schema.TaggedStruct("ErrorsPage", {
	/** The time window's anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	/** The clock at the last read, for relative times. */
	nowMs: Schema.Number,
	summary: SlotSchema(Schema.NullOr(ErrorsSummary)),
	byType: SlotSchema(Schema.Array(ErrorTypeRow)),
	/** `dataUpdatedAt` of the error types, for the "New data" pill. */
	byTypeUpdatedAtMs: Schema.Number,
	facets: SlotSchema(ErrorsFacets),
	/** Cards by fingerprint hash. */
	cards: Schema.Record(Schema.String, Card),
	sections: FilterSections.Model,
	isRefreshing: Schema.Boolean,
	copies: Copies,
})
export type Model = typeof Model.Type
