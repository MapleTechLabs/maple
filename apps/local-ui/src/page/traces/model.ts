import * as CopyButton from "@maple/web/ui/copy-button"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"

// The traces list and its facets, as Schemas.

export const TraceRow = Schema.Struct({
	traceId: Schema.String,
	/** Root span timestamp: the keyset cursor field, paired with `traceId`. */
	startTime: Schema.DateTimeUtc,
	durationMs: Schema.Number,
	/** Null only when a span-mode trace's spans could not be counted. */
	spanCount: Schema.NullOr(Schema.Number),
	services: Schema.Array(Schema.String),
	rootSpanName: Schema.String,
	rootSpanKind: Schema.String,
	rootSpanAttributes: Schema.Record(Schema.String, Schema.String),
	hasError: Schema.Boolean,
})
export type TraceRow = typeof TraceRow.Type

/** The paged list's data: every loaded page, and whether a full last page asks for more. */
export const TracePages = Schema.Struct({ pages: Schema.Array(Schema.Array(TraceRow)), hasNextPage: Schema.Boolean })
export type TracePages = typeof TracePages.Type

export const FacetOption = Schema.Struct({ name: Schema.String, count: Schema.Number })
export type FacetOption = typeof FacetOption.Type

export const DurationStats = Schema.Struct({
	minDurationMs: Schema.Number,
	maxDurationMs: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
})
export type DurationStats = typeof DurationStats.Type

export const TraceFacets = Schema.Struct({
	services: Schema.Array(FacetOption),
	spanNames: Schema.Array(FacetOption),
	httpMethods: Schema.Array(FacetOption),
	httpStatusCodes: Schema.Array(FacetOption),
	deploymentEnvs: Schema.Array(FacetOption),
	namespaces: Schema.Array(FacetOption),
	errorCount: Schema.Number,
	maybeDurationStats: Schema.Option(DurationStats),
})
export type TraceFacets = typeof TraceFacets.Type

/** A debounced text input: what is typed, and a version that retires superseded timers. */
export const Draft = Schema.Struct({ text: Schema.String, version: Schema.Number, sent: Schema.String })
export type Draft = typeof Draft.Type

export const Model = Schema.TaggedStruct("TracesPage", {
	/** The time window's anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	/** The clock at the last read, for relative times. */
	nowMs: Schema.Number,
	traces: SlotSchema(TracePages),
	facets: SlotSchema(TraceFacets),
	isFetchingNextPage: Schema.Boolean,
	/** Bumped when the list is refetched or rekeyed; a next page from an older generation is dropped. */
	pageGeneration: Schema.Number,
	/** `dataUpdatedAt` of the list, for the "New data" pill. */
	tracesUpdatedAtMs: Schema.Number,
	search: Draft,
	/** `RangeFilterSection`'s draft and the committed values it was last formatted from. */
	duration: Schema.Struct({
		min: Schema.String,
		max: Schema.String,
		version: Schema.Number,
		minValue: Schema.NullOr(Schema.Number),
		maxValue: Schema.NullOr(Schema.Number),
	}),
	sections: FilterSections.FilterSectionsBlock.Model,
	isRefreshing: Schema.Boolean,
	/** The empty state's connect guide: its endpoint and exporter environment copy buttons. */
	endpointCopy: CopyButton.CopyButtonBlock.Model,
	envCopy: CopyButton.CopyButtonBlock.Model,
})
export type Model = typeof Model.Type
