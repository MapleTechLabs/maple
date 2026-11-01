import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import { StatusPageSummary } from "../shared/derive"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSession: { orgId: Schema.String, isAdmin: Schema.Boolean },
	CompletedFetchPages: { key: Schema.String, result: outcome(Schema.Array(StatusPageSummary)) },
	ClickedRetry: {},
})
export type Message = typeof Message.Type
