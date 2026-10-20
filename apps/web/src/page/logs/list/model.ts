import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { LogsSearch } from "../../../route/search"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as LogsStream from "../../../ui/logs/logs-stream"
import * as Menu from "../../../ui/menu"
import * as Popover from "../../../ui/popover"
import * as Tooltip from "../../../ui/tooltip"
import * as LogDetail from "../detail"
import { SignalPresenceData } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"

// The `/logs` stream.

import { LogRecord } from "../../../ui/logs/log-row-view"

/** `LogRow` (`@maple/query-engine` route-rows), shared with the stream (`ui/logs`). */
export const LogRowSchema = LogRecord
export type LogRowSchema = LogRecord

/** `LogsResponse`: one page and the cursor of the next (`null` when the page was short). */
export const LogsPage = Schema.Struct({
	logs: Schema.Array(LogRecord),
	cursor: Schema.NullOr(Schema.String),
})
export type LogsPage = typeof LogsPage.Type

const FacetItem = Schema.Struct({ name: Schema.String, count: Schema.Number })
export const LogsFacets = Schema.Struct({
	services: Schema.Array(FacetItem),
	severities: Schema.Array(FacetItem),
	deploymentEnvs: Schema.Array(FacetItem),
	namespaces: Schema.Array(FacetItem),
})
export type LogsFacets = typeof LogsFacets.Type

/** One histogram bucket, severities folded to upper case (`LogsVolumeChart`'s `chartData`). */
export const VolumeBucket = Schema.Struct({
	bucket: Schema.String,
	counts: Schema.Record(Schema.String, Schema.Number),
})
export type VolumeBucket = typeof VolumeBucket.Type

export const AttributeKey = Schema.Struct({ name: Schema.String, count: Schema.Number })
export type AttributeKey = typeof AttributeKey.Type

export const Density = Schema.Literals(["compact", "comfortable"])
export type Density = typeof Density.Type

/** `useInfiniteLogs`' later pages: owned by one first page (`generation`), reset with it. */
export const Pagination = Schema.Struct({
	generation: Schema.Number,
	pages: Schema.Array(LogsPage),
	isFetching: Schema.Boolean,
	/** A page failed: the sentinel stops retrying until the first page or filters change. */
	isStopped: Schema.Boolean,
})
export type Pagination = typeof Pagination.Type

/** `LogsVolumeChart`'s drag-to-zoom: `refAreaLeft`/`refAreaRight` and `isSelecting`. */
export const VolumeBrush = Schema.Struct({
	left: Schema.NullOr(Schema.String),
	right: Schema.NullOr(Schema.String),
	isSelecting: Schema.Boolean,
})
export type VolumeBrush = typeof VolumeBrush.Type

export const Model = Schema.Struct({
	search: LogsSearch,
	/** The resolved window and the clock it was resolved at; `null` until the first resolve. */
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** `listLogsResultAtom`: the first page; later pages are `pagination`. */
	firstPage: KeyedSchema(LogsPage, LoadFailure),
	pagination: Pagination,
	facets: KeyedSchema(LogsFacets, LoadFailure),
	/** The filter rail has mounted: until then its facets are not requested. */
	isFilterRailMounted: Schema.Boolean,
	volume: KeyedSchema(Schema.Array(VolumeBucket), LoadFailure),
	attributeKeys: KeyedSchema(Schema.Array(AttributeKey), LoadFailure),
	volumeChart: Chart.Model,
	volumeBrush: VolumeBrush,
	stream: LogsStream.Model,
	/** `useLogsViewPreferences` (`maple.logs.wrap` / `maple.logs.density`), read on entry. */
	wrap: Schema.Boolean,
	density: Density,
	/** The sidebar's search box text, ahead of its 300 ms debounce into the URL. */
	searchText: Schema.String,
	searchGeneration: Schema.Number,
	locale: Schema.String,
	/** `LogsInspectState`: holds the live tail while the reader inspects. */
	isInspecting: Schema.Boolean,
	isScrolledAway: Schema.Boolean,
	/** `useSignalPresence("logs")`: asked once the empty state painted. */
	presence: SignalPresenceData.schema,
	filterSections: FilterSections.Model,
	timePicker: TimeRangePicker.Model,
	/** `RefreshControls`' cadence menu. */
	refreshMenu: Menu.Model,
	/** The toolbar's three tooltips, one Tooltip shared by its triggers. */
	toolbarTooltip: Tooltip.Model,
	columnsPopover: Popover.Model,
	searchHelp: Popover.Model,
	/** `LogDetailSheet` and the row it shows (`selectedLog`, by index into the stream). */
	detail: LogDetail.Model,
	selectedIndex: Schema.NullOr(Schema.Number),
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	/** `PageRefreshProvider`: Reloads so far (non-zero stops snapping) and the 600 ms spinner. */
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
