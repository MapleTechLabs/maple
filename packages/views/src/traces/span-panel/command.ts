import { Duration, Effect, Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import { writeClipboard } from "../../ui/copy-button"
import { TraceSource } from "../trace-source"
import { DetailFetch, LogsFetch, Message } from "./message"

/** `SpanLogs`' page size; a full page reads "100+". */
export const LOG_LIMIT = 100

/** The span's full attribute maps and events; with `readsCache`, a cached answer comes first. */
export const FetchSpanDetail = Command.define("FetchSpanDetail", {
	args: { ...DetailFetch.fields, readsCache: Schema.Boolean },
	messages: [Message.CompletedFetchDetail, Message.FoundCachedDetail],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ readsCache, ...fetch }) =>
		Effect.gen(function* () {
			const source = yield* TraceSource
			const cached = readsCache && source.cachedSpanDetail ? yield* source.cachedSpanDetail(fetch.request) : Option.none()
			if (Option.isSome(cached))
				return Message.FoundCachedDetail({ fetch, detail: cached.value.data, isFresh: cached.value.isFresh })
			const result = yield* Effect.result(source.spanDetail(fetch.request))
			return Message.CompletedFetchDetail({
				key: fetch.key,
				result: Result.map(result, Option.getOrElse(() => ({ ...fetch.fallback, events: [] }))),
			})
		}),
})

/** The logs carrying the span's context, up to `LOG_LIMIT`; with `readsCache`, a cached answer comes first. */
export const FetchSpanLogs = Command.define("FetchSpanLogs", {
	args: { ...LogsFetch.fields, readsCache: Schema.Boolean },
	messages: [Message.CompletedFetchLogs, Message.FoundCachedLogs],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ readsCache, ...fetch }) =>
		Effect.gen(function* () {
			const source = yield* TraceSource
			const cached = readsCache && source.cachedSpanLogs ? yield* source.cachedSpanLogs(fetch.request) : Option.none()
			if (Option.isSome(cached))
				return Message.FoundCachedLogs({ fetch, logs: cached.value.data, isFresh: cached.value.isFresh })
			const result = yield* Effect.result(source.spanLogs(fetch.request))
			return Message.CompletedFetchLogs({ key: fetch.key, result })
		}),
})

/** `useCopy`'s clipboard write, tagged with the target and generation it was for. */
export const WriteSpanClipboard = Command.define("WriteSpanClipboard", {
	args: { id: Schema.String, text: Schema.String, generation: Schema.Number },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	execute: ({ id, text, generation }) =>
		writeClipboard(text).pipe(
			Effect.map((isOk) =>
				isOk ? Message.SucceededCopy({ id, generation }) : Message.FailedCopy({ id, generation }),
			),
		),
})

export const WaitSpanCopyStatus = Command.define("WaitSpanCopyStatus", {
	args: { id: Schema.String, generation: Schema.Number },
	messages: [Message.ElapsedCopyStatus],
	execute: ({ id, generation }) =>
		Effect.sleep(Duration.millis(2000)).pipe(Effect.as(Message.ElapsedCopyStatus({ id, generation }))),
})
