import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import { StatusPageSummary } from "../shared/derive"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSession: { orgId: Schema.String, grants: Schema.Array(Policy.PermissionName) },
	CompletedFetchPages: { key: Schema.String, result: outcome(Schema.Array(StatusPageSummary)) },
	ClickedRetry: {},
})
export type Message = typeof Message.Type
