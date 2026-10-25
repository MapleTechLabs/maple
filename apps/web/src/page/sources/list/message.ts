import { V2SourceUsageSummary } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as ToggleGroup from "../../../ui/toggle-group"
import { SourceList } from "../kit/data"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchList: { key: Schema.String, result: Schema.Result(SourceList, LoadFailure) },
	CompletedFetchUsage: { key: Schema.String, result: Schema.Result(V2SourceUsageSummary, LoadFailure) },
	ClickedRetry: {},
	/** A row, or its name link (which stops the row's click). */
	ClickedSource: { url: Schema.String },
	GotKindFilterMessage: { message: ToggleGroup.Message },
	GotAttentionFilterMessage: { message: ToggleGroup.Message },
})
export type Message = typeof Message.Type
