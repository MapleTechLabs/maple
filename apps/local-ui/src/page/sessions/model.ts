import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import { Copies } from "../kit/copies"

// The sessions list, as Schemas: the columns the list card reads.

export const SessionRow = Schema.Struct({
	sessionId: Schema.String,
	startTime: Schema.DateTimeUtc,
	durationMs: Schema.NullOr(Schema.Number),
	status: Schema.String,
	lastActivityAt: Schema.NullOr(Schema.DateTimeUtc),
	userId: Schema.String,
	userName: Schema.String,
	userEmail: Schema.String,
	urlInitial: Schema.String,
	browserName: Schema.String,
	osName: Schema.String,
	deviceType: Schema.String,
	pageViews: Schema.Number,
	clickCount: Schema.Number,
	errorCount: Schema.Number,
	traceCount: Schema.Number,
})
export type SessionRow = typeof SessionRow.Type

export const SessionPages = Schema.Struct({
	pages: Schema.Array(Schema.Array(SessionRow)),
	hasNextPage: Schema.Boolean,
})
export type SessionPages = typeof SessionPages.Type

export const FacetOption = Schema.Struct({ name: Schema.String, count: Schema.Number })
export type FacetOption = typeof FacetOption.Type

export const SessionFacets = Schema.Struct({
	service: Schema.Array(FacetOption),
	browser: Schema.Array(FacetOption),
	device: Schema.Array(FacetOption),
	errorCount: Schema.Number,
})
export type SessionFacets = typeof SessionFacets.Type

/** A debounced text input: what is typed, a version retiring superseded timers, the last sent. */
export const Draft = Schema.Struct({ text: Schema.String, version: Schema.Number, sent: Schema.String })
export type Draft = typeof Draft.Type

export const Model = Schema.TaggedStruct("SessionsPage", {
	/** The time window's anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	/** The clock at the last read, for live-ness and relative times. */
	nowMs: Schema.Number,
	sessions: SlotSchema(SessionPages),
	facets: SlotSchema(SessionFacets),
	isFetchingNextPage: Schema.Boolean,
	/** Bumped when the list is refetched or rekeyed; a next page from an older generation is dropped. */
	pageGeneration: Schema.Number,
	/** `dataUpdatedAt` of the list, for the "New data" pill. */
	sessionsUpdatedAtMs: Schema.Number,
	search: Draft,
	sections: FilterSections.Model,
	isRefreshing: Schema.Boolean,
	copies: Copies,
})
export type Model = typeof Model.Type
