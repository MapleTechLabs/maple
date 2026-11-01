import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import * as Tooltip from "../../../../ui/tooltip"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { RailwayServiceRow, RailwayStatus } from "../model"
import { SortKey } from "./model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedLoadStatus: { key: Schema.String, result: Schema.Result(RailwayStatus, LoadFailure) },
	CompletedFetchServices: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(RailwayServiceRow), LoadFailure),
	},
	/** `useIntervalRefresh` while the list is empty (and the status while environments sync). */
	TickedEmptyRefresh: { includeStatus: Schema.Boolean },
	ClickedRetryServices: {},
	ClickedRetryStatus: {},
	ChangedSearch: { value: Schema.String },
	ClickedClearSearch: {},
	ClickedSort: { key: SortKey },
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotRowTooltipMessage: { message: Tooltip.Message },
})
export type Message = typeof Message.Type
