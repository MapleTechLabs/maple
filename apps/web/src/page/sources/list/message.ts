import { V2SourceUsageSummary } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { SourceList } from "../kit/data"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedReadGrants: { grants: Schema.Array(Policy.PermissionName) },
	CompletedFetchList: { key: Schema.String, result: Schema.Result(SourceList, LoadFailure) },
	CompletedFetchUsage: { key: Schema.String, result: Schema.Result(V2SourceUsageSummary, LoadFailure) },
	ClickedRetry: {},
	/** A row, or its name link (which stops the row's click). */
	ClickedSource: { url: Schema.String },
	GotKindFilterMessage: { message: ToggleGroup.Message },
	GotAttentionFilterMessage: { message: ToggleGroup.Message },
})
export type Message = typeof Message.Type
