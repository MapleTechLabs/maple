import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { fetchSpanDetail, fetchSpanLogs, fetchTrace } from "./fetch"
import { Message } from "./message"

export const FetchTrace = Command.define("FetchLocalTraceDetail", {
	args: { key: Schema.String, traceId: Schema.String, apiBase: Schema.String },
	messages: [Message.SucceededFetchTrace, Message.FailedFetchTrace],
	execute: ({ key, traceId, apiBase }) =>
		Effect.gen(function* () {
			const trace = yield* fetchTrace(traceId, apiBase)
			const fetchedAtMs = yield* Clock.currentTimeMillis
			return Message.SucceededFetchTrace({ key, trace, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchTrace({ key, failure })))),
})

export const FetchSpanDetail = Command.define("FetchLocalSpanDetail", {
	args: { key: Schema.String, traceId: Schema.String, spanId: Schema.String, apiBase: Schema.String },
	messages: [Message.SucceededFetchSpanDetail, Message.FailedFetchSpanDetail],
	execute: ({ key, traceId, spanId, apiBase }) =>
		fetchSpanDetail(traceId, spanId, apiBase).pipe(
			Effect.map((detail) => Message.SucceededFetchSpanDetail({ key, detail })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchSpanDetail({ key, failure }))),
		),
})

export const FetchSpanLogs = Command.define("FetchLocalSpanLogs", {
	args: {
		key: Schema.String,
		traceId: Schema.String,
		spanId: Schema.String,
		spanStartTime: Schema.String,
		spanDurationMs: Schema.Number,
		apiBase: Schema.String,
	},
	messages: [Message.SucceededFetchSpanLogs, Message.FailedFetchSpanLogs],
	execute: ({ key, traceId, spanId, spanStartTime, spanDurationMs, apiBase }) =>
		fetchSpanLogs(traceId, spanId, spanStartTime, spanDurationMs, apiBase).pipe(
			Effect.map((logs) => Message.SucceededFetchSpanLogs({ key, logs })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchSpanLogs({ key, failure }))),
		),
})

/** `useCopy`: the clipboard write behind every copy control of the span panel. */
export const WriteClipboard = Command.define("WriteLocalSpanClipboard", {
	args: { id: Schema.String, text: Schema.String, generation: Schema.Number },
	messages: [Message.CompletedWriteClipboard],
	execute: ({ id, text, generation }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
			Effect.as(true),
			Effect.orElseSucceed(() => false),
			Effect.map((isOk) => Message.CompletedWriteClipboard({ id, generation, isOk })),
		),
})

/** The copied or failed state reverts to idle after this long. */
const COPY_TIMEOUT = Duration.millis(2000)

export const WaitCopyStatus = Command.define("WaitLocalSpanCopyStatus", {
	args: { id: Schema.String, generation: Schema.Number },
	messages: [Message.ElapsedCopyStatus],
	execute: ({ id, generation }) => Effect.as(Effect.sleep(COPY_TIMEOUT), Message.ElapsedCopyStatus({ id, generation })),
})
