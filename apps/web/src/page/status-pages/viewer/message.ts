import { StatusPagePublicSnapshot } from "@maple/domain/status-page"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadOutcome } from "../../kit/load-schemas"

export const Message = defineMessageUnion({
	CompletedFetchView: { key: Schema.String, result: LoadOutcome(StatusPagePublicSnapshot) },
	ClickedRetry: {},
})
export type Message = typeof Message.Type
