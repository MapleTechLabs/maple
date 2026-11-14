import { V2Source, V2SourceUsageSummary } from "@maple/domain/http/v2"
import { SourceId } from "@maple/primitives"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import { SourceList } from "../kit/data"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedReadGrants: { grants: Schema.Array(Policy.PermissionName) },
	CompletedFetchList: { key: Schema.String, result: Schema.Result(SourceList, LoadFailure) },
	CompletedFetchUsage: { key: Schema.String, result: Schema.Result(V2SourceUsageSummary, LoadFailure) },
	ClickedRetry: {},
	ChangedSearch: { value: Schema.String },
	/** A paused row's Resume, in place. */
	ClickedResume: { id: SourceId },
	CompletedResume: { result: Schema.Result(V2Source, LoadFailure) },
})
export type Message = typeof Message.Type
