import {
	CostBreakdownResponse,
	CostBreakdownRow,
	CostBreakdownSortBy,
	CostSourcesResponse,
	CostTimeseriesResponse,
	CostTotalsResponse,
	OpenRouterCostKeyRemoved,
	OpenRouterCostKeySaved,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { ChartEnvMessages } from "@maple/views/charts/chart-env"
import { RequestMode } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import { TimeWindow } from "../../data/time-range"
import { COST_GROUP_BYS } from "../../route/search"
import { perDimension } from "./derive"
import * as TimeRangePicker from "../kit/time-range-picker"

/** A read's answer; `key` is what it was requested under, so a stale one is dropped. */
const result = <A, AI>(schema: Schema.Codec<A, AI>) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

const GroupBy = Schema.Literals(COST_GROUP_BYS)

/** The filter rail's values: each dimension's keys by cost, under every filter but its own. */
const FacetRows = Schema.Array(CostBreakdownRow)
export const CostFacets = Schema.Struct(perDimension(() => FacetRows))
export type CostFacets = typeof CostFacets.Type

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedLoadSources: result(CostSourcesResponse),
	CompletedLoadTotals: result(CostTotalsResponse),
	CompletedLoadTimeseries: result(CostTimeseriesResponse),
	CompletedLoadBreakdown: result(CostBreakdownResponse),
	CompletedLoadFacets: result(CostFacets),
	/** A rail checkbox: the value joins the dimension's filter, or leaves it. */
	ToggledFacetValue: { dimension: GroupBy, value: Schema.String },
	/** A rail row's Only: the dimension filtered to that value alone. */
	ClickedOnlyFacetValue: { dimension: GroupBy, value: Schema.String },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	/** Any failed read's Try again: asks again for the ones that failed. */
	ClickedRetry: {},
	PickedGroupBy: { groupBy: GroupBy },
	ClickedSort: { sort: CostBreakdownSortBy },
	ClickedRemoveFilter: { dimension: GroupBy, value: Schema.String },
	ClickedClearFilters: {},
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { message: Chart.Message },
	CompletedReadGrants: { grants: Schema.Array(Policy.PermissionName) },
	/** Opens the add-source dialog on the providers. */
	ClickedAddSource: {},
	ClickedAddOpenRouter: {},
	ClickedBackToProviders: {},
	/** Opens the dialog on the key form, for the source that exists. */
	ClickedReplaceKey: {},
	GotAddDialogMessage: { message: Dialog.Message },
	GotKeyDraftMessage: { message: Field.Message },
	SubmittedKey: {},
	CompletedSaveKey: { result: Schema.Result(OpenRouterCostKeySaved, LoadFailure) },
	ClickedRemoveSource: {},
	GotRemoveDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemove: {},
	CompletedRemoveKey: { result: Schema.Result(OpenRouterCostKeyRemoved, LoadFailure) },
	...ChartEnvMessages,
})
export type Message = typeof Message.Type
