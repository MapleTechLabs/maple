import { V2ErrorIssue, V2ErrorIssueServiceCount, V2Investigation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { ErrorsSearch } from "../../../route/search"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as ContextMenu from "../../../ui/context-menu"
import * as Menu from "../../../ui/menu"
import * as QuickPick from "../kit/quick-pick"
import * as Select from "../../../ui/select"
import * as Tabs from "../../../ui/tabs"
import { SignalPresenceData } from "../../kit/signal-presence"

// The errors list.

/** `ErrorsSummary` (`@maple/query-engine` route-rows). */
export const ErrorsSummary = Schema.Struct({
	totalErrors: Schema.Number,
	totalSpans: Schema.Number,
	errorRate: Schema.Number,
	affectedServicesCount: Schema.Number,
	affectedTracesCount: Schema.Number,
})
export type ErrorsSummary = typeof ErrorsSummary.Type

/** `ErrorByType` (`@maple/web-data/warehouse/errors`). */
export const VolumeRow = Schema.Struct({
	fingerprintHash: Schema.String,
	errorLabel: Schema.String,
	sampleMessage: Schema.String,
	count: Schema.Number,
	affectedServicesCount: Schema.Number,
	firstSeen: Schema.Date,
	lastSeen: Schema.Date,
})

/** `ErrorsSparkSeries`. */
export const SparkSeries = Schema.Struct({
	fingerprintHash: Schema.String,
	points: Schema.Array(Schema.Struct({ bucket: Schema.String, count: Schema.Number })),
})

/** One page of `errorIssues.list`. */
export const IssuePage = Schema.Struct({
	data: Schema.Array(V2ErrorIssue),
	hasMore: Schema.Boolean,
	nextCursor: Schema.NullOr(Schema.String),
})
export type IssuePage = typeof IssuePage.Type

/** A loaded page and the cursor that fetched it (`undefined` cursor is the first page). */
export const PageSlot = Schema.Struct({
	cursor: Schema.NullOr(Schema.String),
	page: KeyedSchema(IssuePage, LoadFailure),
})
export type PageSlot = typeof PageSlot.Type

export const Model = Schema.Struct({
	search: ErrorsSearch,
	/** The trend window (`ERRORS_WINDOW`) and the clock it was resolved at. */
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	summary: KeyedSchema(Schema.NullOr(ErrorsSummary), LoadFailure),
	serviceCounts: KeyedSchema(Schema.Array(V2ErrorIssueServiceCount), LoadFailure),
	environments: KeyedSchema(Schema.Array(Schema.String), LoadFailure),
	/** `ErrorsFilterSidebar` has mounted: until then its counts and environments are not requested. */
	isFilterRailMounted: Schema.Boolean,
	/** The volume sort's warehouse ranking (fingerprints by window volume). */
	ranking: KeyedSchema(Schema.Array(Schema.String), LoadFailure),
	/** The service and env filters the ranking on screen answers (`rankingFiltersOf`). */
	rankedFilters: Schema.NullOr(Schema.String),
	/** The list query the pages extend; a change starts over at page one. */
	listKey: Schema.NullOr(Schema.String),
	pages: Schema.Array(PageSlot),
	volume: KeyedSchema(Schema.Array(VolumeRow), LoadFailure),
	spark: KeyedSchema(Schema.Array(SparkSeries), LoadFailure),
	investigations: KeyedSchema(Schema.Array(V2Investigation), LoadFailure),
	presence: SignalPresenceData.schema,
	selectedIds: Schema.Array(Schema.String),
	/** The last row toggled without shift: a shift-toggle extends from here. */
	selectionAnchor: Schema.NullOr(Schema.String),
	focusedId: Schema.NullOr(Schema.String),
	bulkSeverityMenu: Menu.Model,
	bulkMoveMenu: Menu.Model,
	/** Rows with a write in flight; another write on them waits. */
	writingIds: Schema.Array(Schema.String),
	/** The right-click menu, on the row last pressed. */
	rowMenu: ContextMenu.Model,
	rowMenuTarget: Schema.NullOr(Schema.String),
	/** The one quick-pick open across the list (`openPicker`). */
	picker: Schema.NullOr(
		Schema.Struct({
			issueId: Schema.String,
			kind: Schema.Literals(["severity", "state"]),
			quickPick: QuickPick.Model,
		}),
	),
	/** `ToolbarSearch`'s input and its debounce generation. */
	searchDraft: Schema.String,
	searchGeneration: Schema.Number,
	tabs: Tabs.Model,
	sortSelect: Select.Model,
	severitySelect: Select.Model,
	filterSections: FilterSections.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
