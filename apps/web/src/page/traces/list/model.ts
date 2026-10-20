import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { TracesSearch } from "../../../route/search"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as Dialog from "../../../ui/dialog"
import { AdvancedFilter } from "./advanced-model"
import { SignalPresenceData } from "../../kit/signal-presence"
import { Model as TraceDetailModel } from "../detail/model"
import * as TimeRangePicker from "../../kit/time-range-picker"

// The `/traces` list.

const FacetItem = Schema.Struct({ name: Schema.String, count: Schema.Number })

/** `TracesFacets` (`@maple/web-data/warehouse/traces`). */
export const TracesFacets = Schema.Struct({
	services: Schema.Array(FacetItem),
	spanNames: Schema.Array(FacetItem),
	httpMethods: Schema.Array(FacetItem),
	httpStatusCodes: Schema.Array(FacetItem),
	deploymentEnvs: Schema.Array(FacetItem),
	namespaces: Schema.Array(FacetItem),
	errorCount: Schema.Number,
	durationStats: Schema.Struct({
		minDurationMs: Schema.Number,
		maxDurationMs: Schema.Number,
		p50DurationMs: Schema.Number,
		p95DurationMs: Schema.Number,
	}),
})
export type TracesFacets = typeof TracesFacets.Type

/** The `Trace` fields a list row reads. */
export const TraceRow = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	isRootSpan: Schema.Boolean,
	startTime: Schema.String,
	durationMs: Schema.Number,
	spanCount: Schema.Number,
	services: Schema.Array(Schema.String),
	rootSpanName: Schema.String,
	rootName: Schema.String,
	rootKind: Schema.String,
	rootAttributes: Schema.Record(Schema.String, Schema.String),
	httpStatusCode: Schema.NullOr(Schema.Number),
	hasError: Schema.Boolean,
})
export type TraceRow = typeof TraceRow.Type

/** One `listTraces` page: rows kept, and what the warehouse page scanned before the noise filter. */
export const TracesPage = Schema.Struct({
	rows: Schema.Array(TraceRow),
	scannedCount: Schema.Number,
	hiddenCount: Schema.Number,
})
export type TracesPage = typeof TracesPage.Type

/** One rendered row of the virtual window (`VirtualItem`). */
export const VirtualRow = Schema.Struct({ index: Schema.Number, start: Schema.Number, end: Schema.Number })
export type VirtualRow = typeof VirtualRow.Type

/** `useInfiniteTraces`' pages after the first, for the current first-page key. */
export const Pagination = Schema.Struct({
	key: Schema.NullOr(Schema.String),
	/** Bumped by every fresh set of pages: a page fetched for an earlier one is dropped. */
	generation: Schema.Number,
	pages: Schema.Array(TracesPage),
	isFetching: Schema.Boolean,
	isStopped: Schema.Boolean,
})
export type Pagination = typeof Pagination.Type

export const Model = Schema.Struct({
	search: TracesSearch,
	window: Schema.NullOr(TimeWindow),
	/** The zone `window` was resolved in: a zone change re-resolves "today" (`useEffectiveTimeRange`). */
	windowZone: Schema.NullOr(Schema.String),
	nowMs: Schema.Number,
	facets: KeyedSchema(TracesFacets, LoadFailure),
	firstPage: KeyedSchema(TracesPage, LoadFailure),
	pagination: Pagination,
	/** Settled first pages by key: an atom revisited in the same visit answers from its cache. */
	firstPageCache: Schema.Record(Schema.String, TracesPage),
	/** The virtualizer's window over the loaded rows, as the scroller Mount reports it. */
	virtualRows: Schema.Array(VirtualRow),
	totalSize: Schema.Number,
	presence: SignalPresenceData.schema,
	filterSections: FilterSections.Model,
	timePicker: TimeRangePicker.Model,
	/** The duration inputs' text while typing; committed on blur, Enter or a 400 ms pause. */
	durationDraft: Schema.Struct({ min: Schema.String, max: Schema.String }),
	durationDraftVersion: Schema.Number,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** `useListNavigation`'s focused row, by index (the list is append-only per query). */
	focusedIndex: Schema.NullOr(Schema.Number),
	/** The peek sheet and the trace page running inside it while `peek` is in the URL. */
	peekDialog: Dialog.Model,
	peek: Schema.NullOr(TraceDetailModel),
	advanced: AdvancedFilter,
})
export type Model = typeof Model.Type
