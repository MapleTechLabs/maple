import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { USER_DETAIL_TABS } from "../../../route/search"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { ActivityData, LogsData, ProfileData, TracesData } from "./model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchProfile: result(ProfileData),
	CompletedFetchActivity: result(ActivityData),
	CompletedFetchTraces: result(TracesData),
	CompletedFetchLogs: result(LogsData),
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	ClickedRetry: {},
	ClickedTab: { tab: Schema.Literals(USER_DETAIL_TABS) },
	ClickedNamespace: { namespace: Schema.NullOr(Schema.String) },
	ClickedClearNamespacePin: {},
	GotTimePickerMessage: { message: TimeRangePicker.Message },
})
export type Message = typeof Message.Type
