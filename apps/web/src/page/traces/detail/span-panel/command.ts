import { SpanId, TraceId } from "@maple/domain"
import { listLogs } from "@maple/web-data/warehouse/logs"
import { getSpanDetail } from "@maple/web-data/warehouse/traces"
import { Duration, Effect, Layer, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../../data/load-failure"
import { Message } from "./message"

/** `SpanLogs`' page size; a full page reads "100+". */
export const LOG_LIMIT = 100

/** `getSpanDetailResultAtom({ traceId, spanId, timestamp: span.startTime })`. */
export const FetchSpanDetail = Command.define("FetchSpanDetail", {
	args: { key: Schema.String, traceId: TraceId, spanId: SpanId, timestamp: Schema.String },
	messages: [Message.CompletedFetchDetail],
	handler: function* () {
		return ({ key, traceId, spanId, timestamp }) =>
			getSpanDetail({ data: { traceId, spanId, timestamp } }).pipe(
				Effect.map((detail) => ({
					spanAttributes: detail.spanAttributes,
					resourceAttributes: detail.resourceAttributes,
					events: detail.events,
				})),
				Effect.mapError(toLoadFailure),
				Effect.result,
				Effect.map((result) => Message.CompletedFetchDetail({ key, result })),
			)
	},
})

/** `listLogsResultAtom({ traceId, spanId, limit: LOG_LIMIT })`. */
export const FetchSpanLogs = Command.define("FetchSpanLogs", {
	args: { key: Schema.String, traceId: Schema.String, spanId: Schema.String },
	messages: [Message.CompletedFetchLogs],
	handler: function* () {
		return ({ key, traceId, spanId }) =>
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
			)
	},
})

/** `useCopy`'s clipboard write, tagged with the target and generation it was for. */
export const WriteSpanClipboard = Command.define("WriteSpanClipboard", {
	args: { id: Schema.String, text: Schema.String, generation: Schema.Number },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	handler: function* () {
		return ({ id, text, generation }) =>
			Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
				Effect.as(Message.SucceededCopy({ id, generation })),
				Effect.orElseSucceed(() => Message.FailedCopy({ id, generation })),
			)
	},
})

export const WaitSpanCopyStatus = Command.define("WaitSpanCopyStatus", {
	args: { id: Schema.String, generation: Schema.Number },
	messages: [Message.ElapsedCopyStatus],
	handler: function* () {
		return ({ id, generation }) =>
			Effect.sleep(Duration.millis(2000)).pipe(Effect.as(Message.ElapsedCopyStatus({ id, generation })))
	},
})

/**
 * The four handlers `updateState` needs. Standalone Commands, not Definition-owned: the agent
 * session's span popover returns them from its own Block too, merging this Layer.
 */
export const PanelStateEffectsLayer = Layer.mergeAll(
	FetchSpanDetail.layer,
	FetchSpanLogs.layer,
	WriteSpanClipboard.layer,
	WaitSpanCopyStatus.layer,
)

/** What a panel-state Command requires: one of the handlers `PanelStateEffectsLayer` provides. */
export type PanelStateRequirements = Layer.Success<typeof PanelStateEffectsLayer>
