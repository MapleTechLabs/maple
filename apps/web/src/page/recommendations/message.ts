import { V2AttributeMapping, V2Recommendation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/load-failure"
import * as CopyButton from "../../ui/copy-button"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchList: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(V2Recommendation), LoadFailure),
	},
	CompletedFetchMappings: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(V2AttributeMapping), LoadFailure),
	},
	ClickedRetry: {},
	ClickedApply: {},
	ClickedDismiss: {},
	ClickedReopen: {},
	CompletedApply: { result: Schema.Result(V2AttributeMapping, LoadFailure) },
	CompletedDismiss: { result: Schema.Result(Schema.Void, LoadFailure) },
	CompletedReopen: { result: Schema.Result(Schema.Void, LoadFailure) },
	GotCopyMessage: { message: CopyButton.Message },
})
export type Message = typeof Message.Type
