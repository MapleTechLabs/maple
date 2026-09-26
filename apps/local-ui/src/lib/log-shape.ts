// The local logs list query returns attribute maps as JSON strings
// (`CH.toJSONString`). `normalizeLog` parses them once, inside the query, into
// the `Record<string,string>` shape the shared attribute renderers expect, so
// list rows and the detail drawer share one decoded, identity-stable value.

import type { LogsListOutput } from "@maple/query-engine/ch"
import { parseAttributes } from "@maple/ui/lib/span-tree"

export interface LocalLog {
	timestamp: string
	severityText: string
	severityNumber: number
	serviceName: string
	body: string
	traceId: string
	spanId: string
	/** Hash of the whole stored record: the last tiebreak of the list's keyset cursor. */
	recordIdentity: string
	logAttributes: Record<string, string>
	resourceAttributes: Record<string, string>
}

export function normalizeLog(row: LogsListOutput): LocalLog {
	return {
		timestamp: row.timestamp,
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

/** Stable identity for a log row (selection, React keys). */
export function logKey(log: LocalLog): string {
	return `${log.timestamp}|${log.serviceName}|${log.traceId}|${log.spanId}|${log.recordIdentity}`
}

const SEVERITY_RANK: Record<string, number> = {
	FATAL: 0,
	CRITICAL: 0,
	ERROR: 1,
	WARN: 2,
	WARNING: 2,
	INFO: 3,
	DEBUG: 4,
	TRACE: 5,
}

/** Most severe first; unknown levels after the known ones, alphabetically. */
export function compareSeverity(a: string, b: string): number {
	const rankA = SEVERITY_RANK[a.toUpperCase()] ?? 99
	const rankB = SEVERITY_RANK[b.toUpperCase()] ?? 99
	return rankA - rankB || a.localeCompare(b)
}
