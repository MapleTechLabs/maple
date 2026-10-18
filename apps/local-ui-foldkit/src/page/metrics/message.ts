import * as Chart from "@maple/web-foldkit/charts/chart"
import { ThemeColors } from "@maple/web-foldkit/charts/theme-colors"
import * as CopyButton from "@maple/web-foldkit/ui/copy-button"
import * as FilterSections from "@maple/web-foldkit/ui/filters/filter-sections"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { MetricsListData } from "./catalog"
import { MetricSparkline, SummaryRow } from "./fetch"

export const FacetParam = Schema.Literals(["type", "service"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchList: { key: Schema.String, data: MetricsListData, fetchedAtMs: Schema.Number },
	FailedFetchList: { key: Schema.String, failure: LoadFailure },
	SucceededFetchSummary: { key: Schema.String, rows: Schema.Array(SummaryRow) },
	FailedFetchSummary: { key: Schema.String, failure: LoadFailure },
	SucceededFetchSparklines: { key: Schema.String, sparklines: Schema.Array(MetricSparkline) },
	FailedFetchSparklines: { key: Schema.String, failure: LoadFailure },
	ClickedRefresh: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ChangedSearch: { text: Schema.String },
	ClickedClearSearch: {},
	ElapsedSearchDebounce: { version: Schema.Number },
	ToggledFacetOption: { param: FacetParam, name: Schema.String },
	ClickedClearSidebarFilters: {},
	ClickedClearFilters: {},
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	MeasuredGrid: { width: Schema.Number },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotSparklineMessage: { message: Chart.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
