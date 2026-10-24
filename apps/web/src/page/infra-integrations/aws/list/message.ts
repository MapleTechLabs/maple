import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { AwsStatus, FleetRead, SparkRead, TracedService } from "../data"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedLoadStatus: { key: Schema.String, result: Schema.Result(AwsStatus, LoadFailure) },
	CompletedFetchFleet: { key: Schema.String, result: Schema.Result(Schema.Array(FleetRead), LoadFailure) },
	CompletedFetchSparks: { key: Schema.String, result: Schema.Result(Schema.Array(SparkRead), LoadFailure) },
	CompletedFetchTraced: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(TracedService), LoadFailure),
	},
	ClickedRetryFleet: {},
	ClickedRetryStatus: {},
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	ChangedSearch: { value: Schema.String },
	ClickedClearSearch: {},
	/** `undefined`: every region, or no scope. */
	ClickedRegion: { region: Schema.optional(Schema.String) },
	ClickedScope: { scope: Schema.optional(Schema.String) },
})
export type Message = typeof Message.Type
