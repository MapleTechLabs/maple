import { CachedOf } from "../../data/cached"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { SessionDetail, SessionTrace, TranscriptEvent } from "./model"

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchDetail: {
		key: Schema.String,
		detail: Schema.NullOr(SessionDetail),
		fetchedAtMs: Schema.Number,
	},
	FailedFetchDetail: { key: Schema.String, failure: LoadFailure },
	/** The result cache held this read before the fetch ran (exact keys: no older windows here). */
	FoundCachedDetail: { key: Schema.String, cached: CachedOf(Schema.NullOr(SessionDetail)) },
	SucceededFetchTranscript: {
		key: Schema.String,
		events: Schema.Array(TranscriptEvent),
		fetchedAtMs: Schema.Number,
	},
	FailedFetchTranscript: { key: Schema.String, failure: LoadFailure },
	FoundCachedTranscript: { key: Schema.String, cached: CachedOf(Schema.Array(TranscriptEvent)) },
	SucceededFetchTraces: {
		key: Schema.String,
		traces: Schema.Array(SessionTrace),
		fetchedAtMs: Schema.Number,
	},
	FailedFetchTraces: { key: Schema.String, failure: LoadFailure },
	FoundCachedTraces: { key: Schema.String, cached: CachedOf(Schema.Array(SessionTrace)) },
	ClickedBack: {},
	ClickedRefresh: {},
	ClickedRetryDetail: {},
	/** The root saw the fragment change under the open page; this page reads nothing from it. */
	InformedOfLocationChange: {},
})
export type Message = typeof Message.Type
