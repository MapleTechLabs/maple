import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { LogRecord } from "../../../ui/logs/log-row-view"
import * as LogDetail from "../detail"

// `/logs/$logId`: one log's shareable page.

const LogKey = Schema.Struct({
	timestamp: Schema.String,
	serviceName: Schema.String,
	traceId: Schema.String,
	spanId: Schema.String,
})

export const Model = Schema.Struct({
	logId: Schema.String,
	/** `decodeLogKey(logId)`; `null` is the "link could not be decoded" state. */
	key: Schema.NullOr(LogKey),
	/** `getLogResultAtom`: `null` data is a log that aged out (not found). */
	log: KeyedSchema(Schema.NullOr(LogRecord), LoadFailure),
	/** The sheet's panels in page mode. */
	detail: LogDetail.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CompletedFetchLog: { key: Schema.String, result: Schema.Result(Schema.NullOr(LogRecord), LoadFailure) },
	ClickedRetry: {},
	GotDetailMessage: { message: LogDetail.Message },
})
export type Message = typeof Message.Type
