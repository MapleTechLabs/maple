import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { StatusPageSummary } from "../shared/derive"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSession: SessionGrants,
	CompletedFetchPages: { key: Schema.String, result: LoadOutcome(Schema.Array(StatusPageSummary)) },
	ClickedRetry: {},
})
export type Message = typeof Message.Type
