import {
	CostBreakdownResponse,
	CostSourcesResponse,
	CostTimeseriesResponse,
	CostTotalsResponse,
} from "@maple/domain/http"
import { Schema } from "effect"
import * as Chart from "@maple/views/charts/chart"
import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../data/time-range"
import { CostSearch } from "../../route/search"
import * as TimeRangePicker from "../kit/time-range-picker"

export type Search = typeof CostSearch.Type

export const Model = Schema.Struct({
	search: CostSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** The org's cost sources: they decide between the on-ramp, the first-sync wait and the reads. */
	sources: KeyedSchema(CostSourcesResponse, LoadFailure),
	totals: KeyedSchema(CostTotalsResponse, LoadFailure),
	timeseries: KeyedSchema(CostTimeseriesResponse, LoadFailure),
	breakdown: KeyedSchema(CostBreakdownResponse, LoadFailure),
	timePicker: TimeRangePicker.Model,
	chart: Chart.Model,
	...ChartEnvFields,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
