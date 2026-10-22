import * as Chart from "@maple/web/charts/chart"
import { ThemeColors } from "@maple/web/charts/theme-colors"
import * as CopyButton from "@maple/web/ui/copy-button"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
import { ListRequest, SparklinesRequest, SummaryRequest } from "./requests"
import { MetricsListData } from "./catalog"
import { GridViewport } from "./derive"
import { MetricSparkline, SummaryRow } from "./fetch"

export const FacetParam = Schema.Literals(["type", "service"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchList: { key: Schema.String, data: MetricsListData, fetchedAtMs: Schema.Number },
	FailedFetchList: { key: Schema.String, failure: LoadFailure },
	/** The result cache answered first; `request` is the read the fetch then repeats. */
	FoundCachedList: { request: ListRequest, cached: CachedOf(MetricsListData) },
	SucceededFetchSummary: { key: Schema.String, rows: Schema.Array(SummaryRow), fetchedAtMs: Schema.Number },
	FailedFetchSummary: { key: Schema.String, failure: LoadFailure },
	FoundCachedSummary: { request: SummaryRequest, cached: CachedOf(Schema.Array(SummaryRow)) },
	SucceededFetchSparklines: {
		key: Schema.String,
		sparklines: Schema.Array(MetricSparkline),
		fetchedAtMs: Schema.Number,
	},
	FailedFetchSparklines: { key: Schema.String, failure: LoadFailure },
	FoundCachedSparklines: { request: SparklinesRequest, cached: CachedOf(Schema.Array(MetricSparkline)) },
	ClickedRefresh: {},
	ClickedOpenFilters: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ChangedSearch: { text: Schema.String },
	ClickedClearSearch: {},
	ElapsedSearchDebounce: { version: Schema.Number },
	ToggledFacetOption: { param: FacetParam, name: Schema.String },
	ClickedClearSidebarFilters: {},
	ClickedClearFilters: {},
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	MeasuredGrid: { viewport: GridViewport },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotSparklineMessage: { message: Chart.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
