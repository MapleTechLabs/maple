// The local logs list query returns attribute maps as JSON strings
// (`CH.toJSONString`). `normalizeLog` parses them into the `Record<string,string>`
// shape the shared attribute renderers + chip pickers expect, so list rows and
// the detail drawer work off one decoded value.

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
		logAttributes: parseAttributes(row.logAttributes),
		resourceAttributes: parseAttributes(row.resourceAttributes),
	}
}
