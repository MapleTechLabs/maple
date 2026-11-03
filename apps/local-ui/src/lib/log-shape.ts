// The local logs list query returns attribute maps as JSON strings
// (`CH.toJSONString`). `normalizeLog` parses them once, inside the query, into
// the `Record<string,string>` shape the shared attribute renderers expect, so
// list rows and the detail drawer share one decoded, identity-stable value.

import { SpanId, TraceId } from "@maple/domain"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import type { LogsListOutput } from "@maple/query-engine/ch"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { severityRank } from "@maple/ui/lib/severity"
import type { LogRecord } from "@maple/views/ui/logs/log-row-view"
import { Option, Schema, String as Str } from "effect"

/** One log row, attribute maps already decoded. */
export const LocalLog = Schema.Struct({
	/** The stored `DateTime64(9)` value with its nanoseconds: shown verbatim and the keyset cursor. */
	timestamp: Schema.String,
	severityText: Schema.String,
	severityNumber: Schema.Number,
	serviceName: Schema.String,
	body: Schema.String,
	traceId: Schema.String,
	spanId: Schema.String,
	recordIdentity: Schema.String,
	logAttributes: Schema.Record(Schema.String, Schema.String),
	resourceAttributes: Schema.Record(Schema.String, Schema.String),
})
export type LocalLog = typeof LocalLog.Type

export function normalizeLog(row: LogsListOutput): LocalLog {
	return {
		timestamp: row.exactTimestamp,
		severityText: row.severityText,
		severityNumber: row.severityNumber,
		serviceName: row.serviceName,
		body: row.body,
		traceId: row.traceId,
		spanId: row.spanId,
		recordIdentity: row.recordIdentity,
		logAttributes: parseAttributes(row.logAttributes),
		resourceAttributes: parseAttributes(row.resourceAttributes),
	}
}

/** Stable identity for a log row (selection, keyed rows). */
export function logKey(log: LocalLog): string {
	return `${log.timestamp}|${log.serviceName}|${log.traceId}|${log.spanId}|${log.recordIdentity}`
}

const decodeTraceId = Schema.decodeUnknownOption(TraceId)
const decodeSpanId = Schema.decodeUnknownOption(SpanId)

/** `LocalLog` keeps the stored `DateTime64(9)` and empty ids; the shared views want ISO, the exact value and no ids. */
export const toLogRecord = (log: LocalLog): LogRecord => ({
	timestamp: warehouseDateTimeToIso(log.timestamp),
	exactTimestamp: log.timestamp,
	recordIdentity: log.recordIdentity,
	severityText: log.severityText,
	severityNumber: log.severityNumber,
	serviceName: log.serviceName,
	body: log.body,
	traceId: Option.getOrUndefined(decodeTraceId(log.traceId)),
	spanId: Option.getOrUndefined(decodeSpanId(log.spanId)),
	logAttributes: log.logAttributes,
	resourceAttributes: log.resourceAttributes,
})

/** `logKey` of the log a `toLogRecord` came from. */
export const logRecordKey = (record: LogRecord): string =>
	`${record.exactTimestamp}|${record.serviceName}|${record.traceId ?? ""}|${record.spanId ?? ""}|${record.recordIdentity ?? ""}`

/** Most severe first; unknown levels after the known ones, alphabetically. */
export function compareSeverity(a: string, b: string): number {
	return severityRank(a) - severityRank(b) || Str.localeCompare(b)(a)
}
