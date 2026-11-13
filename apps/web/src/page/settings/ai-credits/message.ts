import { AiCreditUsageResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"

export const Message = defineMessageUnion({
	CompletedFetchUsage: { result: Schema.Result(AiCreditUsageResponse, LoadFailure) },
	ClickedRetry: {},
})
export type Message = typeof Message.Type
