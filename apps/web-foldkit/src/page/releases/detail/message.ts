import { VcsCommitDetailResponse, VcsCommitRangeResponse } from "@maple/domain/http"
import { V2ErrorIssue } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { RequestMode } from "../list/message"
import { ReleasesData } from "../list/model"

const result = <A extends Schema.Top>(schema: A) => ({ key: Schema.String, result: Schema.Result(schema, LoadFailure) })

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchCommit: result(VcsCommitDetailResponse),
	CompletedFetchReleases: result(ReleasesData),
	CompletedFetchChangeset: result(Schema.Array(VcsCommitRangeResponse)),
	CompletedFetchIssues: result(Schema.Array(V2ErrorIssue)),
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedRetry: {},
	ClickedResetTimeRange: {},
	GotTimePickerMessage: { message: TimeRangePicker.Message },
})
export type Message = typeof Message.Type
