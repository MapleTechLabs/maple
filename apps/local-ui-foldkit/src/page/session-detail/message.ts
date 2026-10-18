import * as CopyButton from "@maple/web-foldkit/ui/copy-button"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { SessionDetail, SessionTrace, TranscriptEvent } from "./model"

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchDetail: { key: Schema.String, detail: Schema.NullOr(SessionDetail), fetchedAtMs: Schema.Number },
	FailedFetchDetail: { key: Schema.String, failure: LoadFailure },
	SucceededFetchTranscript: { key: Schema.String, events: Schema.Array(TranscriptEvent) },
	FailedFetchTranscript: { key: Schema.String, failure: LoadFailure },
	SucceededFetchTraces: { key: Schema.String, traces: Schema.Array(SessionTrace) },
	FailedFetchTraces: { key: Schema.String, failure: LoadFailure },
	ClickedBack: {},
	ClickedRefresh: {},
	ClickedRetryDetail: {},
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
