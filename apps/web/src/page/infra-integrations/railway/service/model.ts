import { Schema } from "effect"
import * as Chart from "../../../../charts/chart"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraRailwayServiceSearch } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { TracedService } from "../../kit/traced"
import { RailwayServiceRow, RailwayServiceTimeseriesRow } from "../model"

// `/infra/railway/$serviceId`.

export const Model = Schema.Struct({
	serviceId: Schema.String,
	search: InfraRailwayServiceSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	services: KeyedSchema(Schema.Array(RailwayServiceRow), LoadFailure),
	timeseries: KeyedSchema(Schema.Array(RailwayServiceTimeseriesRow), LoadFailure),
	/** The window's traced services: the one named like this service is its "traced as". */
	traced: KeyedSchema(Schema.Array(TracedService), LoadFailure),
	charts: Schema.Record(Schema.String, Chart.Model),
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
