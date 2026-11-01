import { SpanId, TraceId } from "@maple/domain"
import { listLogs } from "@maple/web-data/warehouse/logs"
import { getSpanDetail } from "@maple/web-data/warehouse/traces"
import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../../data/load-failure"
import { writeClipboard } from "../../../kit/clipboard"
import { Message } from "./message"

/** `SpanLogs`' page size; a full page reads "100+". */
export const LOG_LIMIT = 100

/** `getSpanDetailResultAtom({ traceId, spanId, timestamp: span.startTime })`. */
export const FetchSpanDetail = Command.define("FetchSpanDetail", {
	args: { key: Schema.String, traceId: TraceId, spanId: SpanId, timestamp: Schema.String },
	messages: [Message.CompletedFetchDetail],
	execute: ({ key, traceId, spanId, timestamp }) =>
		getSpanDetail({ data: { traceId, spanId, timestamp } }).pipe(
			Effect.map((detail) => ({
				spanAttributes: detail.spanAttributes,
				resourceAttributes: detail.resourceAttributes,
				events: detail.events,
			})),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDetail({ key, result })),
		),
})

/** `listLogsResultAtom({ traceId, spanId, limit: LOG_LIMIT })`. */
export const FetchSpanLogs = Command.define("FetchSpanLogs", {
	args: { key: Schema.String, traceId: Schema.String, spanId: Schema.String },
	messages: [Message.CompletedFetchLogs],
	execute: ({ key, traceId, spanId }) =>
		listLogs({ data: { traceId, spanId, limit: LOG_LIMIT } }).pipe(
			Effect.map((response) =>
				response.data.map((log) => ({
					timestamp: log.timestamp,
					severityText: log.severityText,
					body: log.body,
				})),
			),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchLogs({ key, result })),
		),
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
