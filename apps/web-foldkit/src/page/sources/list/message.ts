import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import { SourceList } from "../kit/data"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchList: { key: Schema.String, result: Schema.Result(SourceList, LoadFailure) },
	ClickedRetry: {},
	/** A row, or its name link (which stops the row's click). */
	ClickedSource: { url: Schema.String },
})
export type Message = typeof Message.Type
