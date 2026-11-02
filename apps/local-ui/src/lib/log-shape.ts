// The local logs list query returns attribute maps as JSON strings
// (`CH.toJSONString`). `normalizeLog` parses them once, inside the query, into
// the `Record<string,string>` shape the shared attribute renderers expect, so
// list rows and the detail drawer share one decoded, identity-stable value.

import type { LogsListOutput } from "@maple/query-engine/ch"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { severityRank } from "@maple/ui/lib/severity"
import { Schema } from "effect"

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

/** Most severe first; unknown levels after the known ones, alphabetically. */
export function compareSeverity(a: string, b: string): number {
	return severityRank(a) - severityRank(b) || a.localeCompare(b)
}
