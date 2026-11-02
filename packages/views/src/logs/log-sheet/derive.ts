import type { LogRecord } from "../../ui/logs/log-row-view"

// Pure readings of a log for the sheet: its JSON payload and its tabs.

// The log as the Raw tab's JSON.
export const buildLogJsonPayload = (log: LogRecord): string =>
	JSON.stringify(
		{
			// The stored value, nanoseconds kept.
			timestamp: log.exactTimestamp,
			severityText: log.severityText,
			severityNumber: log.severityNumber,
			serviceName: log.serviceName,
			body: log.body,
			traceId: log.traceId || undefined,
			spanId: log.spanId || undefined,
			logAttributes: log.logAttributes,
			resourceAttributes: log.resourceAttributes,
		},
		null,
		2,
	)

/** The tabs a log gets, in order: Trace needs a trace, Infrastructure an app that can back it. */
export const tabValues = (log: LogRecord, hasInfra: boolean): ReadonlyArray<string> => [
	"attributes",
	...(log.traceId ? ["trace"] : []),
	"context",
	"raw",
	...(hasInfra ? ["infrastructure"] : []),
]

export const TAB_LABELS = new Map([
	["attributes", "Attributes"],
	["trace", "Trace"],
	["context", "Context"],
	["raw", "Raw"],
	["infrastructure", "Infrastructure"],
])
