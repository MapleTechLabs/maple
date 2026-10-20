import { warehouseDateTimeToIso } from "@maple/query-engine"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { getActiveInfraCorrelations } from "../../../components/infra/infra-correlations"
import type { LogRecord } from "../../../ui/logs/log-row-view"

// Pure readings of a log for the sheet: its severity label, JSON payload, tabs and timestamp.

const SEVERITY_NUMBER_LABELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const

// copied: `severityLabel` (packages/ui/src/components/logs/severity-badge.tsx, a React module).
export const severityLabel = (severityText: string, severityNumber?: number): string => {
	if (severityText.trim() !== "") return severityText
	if (severityNumber !== undefined && severityNumber >= 1 && severityNumber <= 24)
		return SEVERITY_NUMBER_LABELS[Math.floor((severityNumber - 1) / 4)] ?? "UNSET"
	return "UNSET"
}

// The log as the Raw tab's JSON.
export const buildLogJsonPayload = (log: LogRecord): string =>
	JSON.stringify(
		{
			timestamp: log.timestamp,
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

export const hasInfraCorrelations = (log: LogRecord): boolean =>
	getActiveInfraCorrelations(log.resourceAttributes).length > 0

/** The tabs a log gets, in order: Trace needs a trace, Infrastructure a host or pod. */
export const tabValues = (log: LogRecord): ReadonlyArray<string> => [
	"attributes",
	...(log.traceId ? ["trace"] : []),
	"context",
	"raw",
	...(hasInfraCorrelations(log) ? ["infrastructure"] : []),
]

export const TAB_LABELS = new Map([
	["attributes", "Attributes"],
	["trace", "Trace"],
	["context", "Context"],
	["raw", "Raw"],
	["infrastructure", "Infrastructure"],
])

/** `formatTimestampInTimezone(ts, { timeZone, withMilliseconds: true })`: `Oct 1, 11:59:59.023 AM`. */
export const formatLogTimestamp = (timestamp: string, timeZone: string): string => {
	const date = new Date(warehouseDateTimeToIso(timestamp))
	if (Number.isNaN(date.getTime())) return EMPTY_VALUE
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: 3,
	}).format(date)
}
