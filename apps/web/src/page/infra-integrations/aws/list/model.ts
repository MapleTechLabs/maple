import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraAwsSearch } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { AwsStatus, FleetRead, SparkRead, TracedService } from "../data"

// `/infra/aws`.

export const Model = Schema.Struct({
	search: InfraAwsSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(AwsStatus, LoadFailure),
	fleet: KeyedSchema(Schema.Array(FleetRead), LoadFailure),
	/** The shown tab's row sparklines. */
	sparks: KeyedSchema(Schema.Array(SparkRead), LoadFailure),
	/** Traced services, for the "Traced as" column. */
	traced: KeyedSchema(Schema.Array(TracedService), LoadFailure),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
