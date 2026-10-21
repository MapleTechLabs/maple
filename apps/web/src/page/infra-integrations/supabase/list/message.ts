import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { SupabaseProjectRow, SupabaseStatus } from "../model"
import { SortKey } from "./model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedLoadStatus: { key: Schema.String, result: Schema.Result(SupabaseStatus, LoadFailure) },
	CompletedFetchProjects: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(SupabaseProjectRow), LoadFailure),
	},
	/** Every 30 s while switched-on projects wait for their first scrape. */
	TickedWaitingRefresh: {},
	ClickedRetryProjects: {},
	ClickedRetryStatus: {},
	ChangedSearch: { value: Schema.String },
	ClickedClearSearch: {},
	ClickedSort: { key: SortKey },
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
})
export type Message = typeof Message.Type
