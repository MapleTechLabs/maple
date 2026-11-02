import { SpanId, TraceId } from "@maple/domain"
import { type LogRow, warehouseDateTimeToIso } from "@maple/query-engine"
import { type LogRowLinks, type LogRowView, logTimeFormat, toLogRowView } from "@maple/views/ui/logs/log-row-view"
import { Option, Schema } from "effect"
import { hrefFor } from "../../route"
import type { LocalLog } from "./model"

// Maple Local's log as the shared logs stream reads it.

const decodeTraceId = Schema.decodeUnknownOption(TraceId)
const decodeSpanId = Schema.decodeUnknownOption(SpanId)

/** `LocalLog` keeps the stored `DateTime64(9)` and empty ids; `LogRow` wants ISO, the exact value and no ids. */
export const toLogRecord = (log: LocalLog): LogRow => ({
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

/** A trace opens in Local's trace page; Local has no page for a single log, so no permalink. */
export const LOCAL_LOG_LINKS: LogRowLinks = {
	trace: (traceId) => hrefFor(`/traces/${encodeURIComponent(traceId)}`),
	log: Option.none(),
}

export const toStreamRows = (
	logs: ReadonlyArray<LocalLog>,
	columns: ReadonlyArray<string>,
	timeZone: string,
): ReadonlyArray<LogRowView> => {
	const time = logTimeFormat(timeZone)
	return logs.map((log) => toLogRowView(toLogRecord(log), columns, time, LOCAL_LOG_LINKS))
}
