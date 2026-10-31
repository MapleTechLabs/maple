import { Schema } from "effect"
import * as Chart from "../../../../charts/chart"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraAwsResourceSearch } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { TracedService } from "../../kit/traced"
import { BucketPoint, KindId } from "../data"

// `/infra/aws/$kind/$name`.

export const Model = Schema.Struct({
	/** Null for a kind this page does not know: it says so instead of reading. */
	kind: Schema.NullOr(KindId),
	name: Schema.String,
	search: InfraAwsResourceSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	timeseries: KeyedSchema(Schema.Array(BucketPoint), LoadFailure),
	traced: KeyedSchema(Schema.Array(TracedService), LoadFailure),
	charts: Schema.Record(Schema.String, Chart.Model),
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
