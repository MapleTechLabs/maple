import { warehouseDateTimeToIso, type LogRow } from "@maple/query-engine"
import { getServiceColor } from "@maple/ui/lib/colors"
import { EMPTY_VALUE } from "@maple/ui/lib/empty-value"
import { countLabel } from "@maple/ui/lib/format"
import { pickImportantAttributes } from "@maple/ui/lib/log-attributes"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { stripAnsi } from "@maple/ui/components/logs/strip-ansi"
import { encodeLogKey } from "../../lib/log-key"
import { tryParseJson } from "../../lib/display-text"
import { SpanId, TraceId } from "@maple/domain"
import { Option, Schema } from "effect"

/** `LogRow` (`@maple/query-engine` route-rows): one log as the list renders it. */
export const LogRecord = Schema.Struct({
	timestamp: Schema.String,
	exactTimestamp: Schema.String,
	recordIdentity: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
	severityText: Schema.String,
	severityNumber: Schema.Number,
	serviceName: Schema.String,
	body: Schema.String,
	traceId: Schema.UndefinedOr(TraceId),
	spanId: Schema.UndefinedOr(SpanId),
	logAttributes: Schema.Record(Schema.String, Schema.String),
	resourceAttributes: Schema.Record(Schema.String, Schema.String),
})
export type LogRecord = typeof LogRecord.Type

/**
 * Everything a log row renders, derived once per data, pin or timezone change (in `update`), so
 * scrolling only builds markup.
 */
export const LogChip = Schema.Struct({
	key: Schema.String,
	value: Schema.String,
	tone: Schema.Literals(["crit", "warn", "emphasis", "muted"]),
	source: Schema.Literals(["log", "resource"]),
	displayKey: Schema.String,
	displayValue: Schema.String,
	isJson: Schema.Boolean,
})
export type LogChip = typeof LogChip.Type

export const PinnedCell = Schema.Struct({
	key: Schema.String,
	value: Schema.String,
	isEmpty: Schema.Boolean,
	isNumeric: Schema.Boolean,
})
export type PinnedCell = typeof PinnedCell.Type

export const LogRowView = Schema.Struct({
	timeMain: Schema.String,
	timeFraction: Schema.String,
	timeTitle: Schema.String,
	severity: Schema.String,
	severityColor: Schema.String,
	serviceName: Schema.String,
	serviceColor: Schema.String,
	body: Schema.String,
	firstLine: Schema.String,
	/** `3 lines` (shown as `+3 lines`) when the body has more lines than the row shows, else empty. */
	hiddenLinesLabel: Schema.String,
	rawBody: Schema.String,
	traceId: Schema.String,
	logKey: Schema.String,
	pinned: Schema.Array(PinnedCell),
	chips: Schema.Array(LogChip),
	/** The log itself: the expanded body, its attributes and the JSON copy read it. */
	log: LogRecord,
})
export type LogRowView = typeof LogRowView.Type

/** Chips shown beside the message; the rest are one expand away. */
const MAX_INLINE_CHIPS = 3
const MAX_VALUE_CHARS = 24
const SEVERITY_NUMBER_LABELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const

// packages/ui/src/components/logs/severity-badge.tsx `severityLabel` (a React module).
export const severityLabel = (severityText: string, severityNumber?: number): string => {
	if (severityText.trim() !== "") return severityText
	if (severityNumber !== undefined && severityNumber >= 1 && severityNumber <= 24)
		return SEVERITY_NUMBER_LABELS[Math.floor((severityNumber - 1) / 4)] ?? "UNSET"
	return "UNSET"
}

const isJsonValue = (value: string): boolean => Option.isSome(tryParseJson(value))

// packages/ui/src/components/logs/log-attribute-chip.tsx `shortKey` / `truncateValue`.
const shortKey = (key: string): string => {
	if (key === "http.status_code" || key === "http.response.status_code") return "status"
	if (key === "http.method" || key === "http.request.method") return "method"
	if (key === "http.url" || key === "url.full") return "url"
	if (key === "http.route" || key === "url.path") return "path"
	return key
}
const truncateValue = (value: string): string =>
	value.length <= MAX_VALUE_CHARS ? value : value.slice(0, MAX_VALUE_CHARS - 1) + "…"

/** The compact and full timestamp formatters for the viewer's time zone. */
export interface LogTimeFormat {
	readonly compact: Intl.DateTimeFormat
	readonly full: Intl.DateTimeFormat
}

export const logTimeFormat = (timeZone: string): LogTimeFormat => ({
	compact: new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: 3,
		hour12: false,
	}),
	full: new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: 3,
	}),
})

const formatWith = (formatter: Intl.DateTimeFormat, timestamp: string): string => {
	const date = new Date(warehouseDateTimeToIso(timestamp))
	return Number.isNaN(date.getTime()) ? EMPTY_VALUE : formatter.format(date)
}

/** One row's display values; `pinnedColumns` leave the chip lane and get their own cells. */
export const toLogRowView = (
	log: LogRow,
	pinnedColumns: ReadonlyArray<string>,
	time: LogTimeFormat,
): LogRowView => {
	const pinned = new Set(pinnedColumns)
	const body = stripAnsi(log.body)
	const lines = body.split("\n")
	const severity = severityLabel(log.severityText, log.severityNumber).toUpperCase()
	const compact = formatWith(time.compact, log.timestamp)
	const dot = compact.lastIndexOf(".")
	const chips = pickImportantAttributes(log, Number.POSITIVE_INFINITY)
		.filter(
			(attr) =>
				attr.source === "log" &&
				!pinned.has(attr.key) &&
				!(attr.value.length >= 3 && log.body.includes(attr.value)),
		)
		.slice(0, MAX_INLINE_CHIPS)
		.map((attr) => {
			const isJson = isJsonValue(attr.value)
			return {
				...attr,
				displayKey: shortKey(attr.key),
				displayValue: isJson ? "{…}" : truncateValue(attr.value),
				isJson,
			}
		})
	return {
		timeMain: dot === -1 ? compact : compact.slice(0, dot),
		timeFraction: dot === -1 ? "" : compact.slice(dot),
		timeTitle: formatWith(time.full, log.timestamp),
		severity,
		severityColor: getSeverityColor(severity),
		serviceName: log.serviceName,
		serviceColor: getServiceColor(log.serviceName),
		body,
		firstLine: lines[0] ?? "",
		hiddenLinesLabel: lines.length > 1 ? countLabel(lines.length - 1, "line") : "",
		rawBody: log.body,
		traceId: log.traceId ?? "",
		logKey: encodeLogKey(log),
		pinned: pinnedColumns.map((key) => {
			const value = log.logAttributes[key] ?? log.resourceAttributes[key] ?? EMPTY_VALUE
			const isEmpty = value === EMPTY_VALUE
			return {
				key,
				value,
				isEmpty,
				isNumeric: !isEmpty && value.trim() !== "" && !Number.isNaN(Number(value)),
			}
		}),
		chips,
		log,
	}
}
