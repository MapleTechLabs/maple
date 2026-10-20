import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { ReplaysSearch } from "../../../route/search"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { SignalPresenceData } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { SessionRow } from "../kit/session-row"
import { VirtualWindow } from "../kit/virtualize"

// The `/replays` list.

export type Search = typeof ReplaysSearch.Type

/** One `listReplays` page. */
export const ReplaysPage = Schema.Struct({
	rows: Schema.Array(SessionRow),
	hasMore: Schema.Boolean,
	nextCursor: Schema.NullOr(Schema.String),
})
export type ReplaysPage = typeof ReplaysPage.Type

const FacetItem = Schema.Struct({ name: Schema.String, count: Schema.Number })

/** `getReplaysFacets`: option counts, header totals and the session-length distribution. */
export const ReplaysFacets = Schema.Struct({
	services: Schema.Array(FacetItem),
	browsers: Schema.Array(FacetItem),
	countries: Schema.Array(FacetItem),
	devices: Schema.Array(FacetItem),
	groups: Schema.Array(FacetItem),
	pages: Schema.Array(FacetItem),
	tags: Schema.Array(FacetItem),
	errorCount: Schema.Number,
	totalSessions: Schema.Number,
	liveSessions: Schema.Number,
	durationBuckets: Schema.Array(FacetItem),
	durationP50: Schema.Number,
	durationP95: Schema.Number,
})
export type ReplaysFacets = typeof ReplaysFacets.Type

/** `useInfiniteReplays`' pages after the first, for the current first-page key. */
export const Pagination = Schema.Struct({
	key: Schema.NullOr(Schema.String),
	/** Bumped by every fresh set of pages (a new key or a Reload): an older page is dropped. */
	generation: Schema.Number,
	pages: Schema.Array(ReplaysPage),
	isFetching: Schema.Boolean,
	isStopped: Schema.Boolean,
})
export type Pagination = typeof Pagination.Type

const Draft = Schema.Struct({ min: Schema.String, max: Schema.String })

export const Model = Schema.Struct({
	search: ReplaysSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	firstPage: KeyedSchema(ReplaysPage, LoadFailure),
	pagination: Pagination,
	facets: KeyedSchema(ReplaysFacets, LoadFailure),
	/** Folded low-signal runs the reader opened, by their first session id. */
	expandedRuns: Schema.Array(Schema.String),
	/** The virtualizer's window over the rows, as the list Mount reports it. */
	virtualWindow: VirtualWindow,
	presence: SignalPresenceData.schema,
	/** `ToolbarSearch`: what is typed, and the debounce run that may still commit it. */
	query: Schema.String,
	queryGeneration: Schema.Number,
	/** The sidebar's identity inputs; each commits on Enter. */
	userText: Schema.String,
	userIdText: Schema.String,
	durationDraft: Draft,
	activeDraft: Draft,
	/** The hovered histogram bar per range (`RangeHistogram`'s readout). */
	histogramHover: Schema.Record(Schema.String, Schema.Number),
	draftVersion: Schema.Number,
	filterSections: FilterSections.Model,
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
