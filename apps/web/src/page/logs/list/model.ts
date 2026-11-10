import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { Schema } from "effect"
import * as Chart from "@maple/views/charts/chart"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { LogsSearch } from "../../../route/search"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import * as LogsStream from "@maple/views/ui/logs/logs-stream"
import * as Menu from "@maple/views/ui/menu"
import * as Popover from "@maple/views/ui/popover"
import * as Tooltip from "@maple/views/ui/tooltip"
import * as LogDetail from "@maple/views/logs/log-sheet"
import * as InfraCorrelation from "../../kit/infra-correlation"
import { SignalPresenceData } from "@maple/views/data/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"

import { LogRecord } from "@maple/views/ui/logs/log-row-view"
import { Density } from "@maple/views/ui/logs/viewer"
import { laterPagesFields } from "../../kit/infinite-pages"

export const LogRowSchema = LogRecord
export type LogRowSchema = LogRecord

/** One page and the cursor of the next (`null` when the page was short). */
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

/** One histogram bucket, severities folded to upper case. */
export const VolumeBucket = Schema.Struct({
	bucket: Schema.String,
	counts: Schema.Record(Schema.String, Schema.Number),
})
export type VolumeBucket = typeof VolumeBucket.Type

export const AttributeKey = Schema.Struct({ name: Schema.String, count: Schema.Number })
export type AttributeKey = typeof AttributeKey.Type

/** Later pages: owned by one first page (`generation`), reset with it. */
export const Pagination = Schema.Struct(laterPagesFields(LogsPage))
export type Pagination = typeof Pagination.Type

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
	/** The first page; later pages are `pagination`. */
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
	/** Stored as `maple.logs.wrap` / `maple.logs.density`, read on entry. */
	wrap: Schema.Boolean,
	density: Density,
	/** The sidebar's search box text, ahead of its 300 ms debounce into the URL. */
	searchText: Schema.String,
	searchGeneration: Schema.Number,
	locale: Schema.String,
	/** Holds the live tail while the reader inspects. */
	isInspecting: Schema.Boolean,
	isScrolledAway: Schema.Boolean,
	/** Asked once the empty state painted. */
	presence: SignalPresenceData.schema,
	filterSections: FilterSections.Model,
	timePicker: TimeRangePicker.Model,
	refreshMenu: Menu.Model,
	/** The toolbar's three tooltips, one Tooltip shared by its triggers. */
	toolbarTooltip: Tooltip.Model,
	columnsPopover: Popover.Model,
	searchHelp: Popover.Model,
	/** The log sheet; `selectedIndex` is its row, by index into the stream. */
	detail: LogDetail.Model,
	/** The sheet's Infrastructure tab, rebuilt per log. */
	detailInfra: InfraCorrelation.Model,
	selectedIndex: Schema.NullOr(Schema.Number),
	...ChartEnvFields,
	/** Reloads so far (non-zero stops snapping) and the 600 ms spinner. */
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
