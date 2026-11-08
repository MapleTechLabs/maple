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
import { Option, Schema, Array as Arr, String as Str } from "effect"

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
	/** The instant and the zone its text reads in, for the row's timestamp card. */
	timeMs: Schema.Number,
	timeZone: Schema.String,
	severity: Schema.String,
	severityColor: Schema.String,
	serviceName: Schema.String,
	serviceColor: Schema.String,
	body: Schema.String,
	firstLine: Schema.String,
	/** `3 lines` (shown as `+3 lines`) when the body has more lines than the row shows, else empty. */
	hiddenLinesLabel: Schema.String,
	rawBody: Schema.String,
	/** The row's trace page, empty when the log has no trace. */
	traceHref: Schema.String,
	/** The log's own page (its permalink), empty when the app has none. */
	logHref: Schema.String,
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
	if (Str.trim(severityText) !== "") return severityText
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
	value.length <= MAX_VALUE_CHARS ? value : Str.slice(0, MAX_VALUE_CHARS - 1)(value) + "…"

/** The compact timestamp formatter for the viewer's time zone, and that zone. */
export interface LogTimeFormat {
	readonly compact: Intl.DateTimeFormat
	readonly timeZone: string
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
	timeZone,
})

const formatWith = (formatter: Intl.DateTimeFormat, epochMs: number): string =>
	Number.isNaN(epochMs) ? EMPTY_VALUE : formatter.format(epochMs)

/** Where a row links: the app's trace page, and its standalone log page if it has one. */
export interface LogRowLinks {
	readonly trace: (traceId: string) => string
	readonly log: Option.Option<(logKey: string) => string>
}

/** One row's display values; `pinnedColumns` leave the chip lane and get their own cells. */
export const toLogRowView = (
	log: LogRow,
	pinnedColumns: ReadonlyArray<string>,
	time: LogTimeFormat,
	links: LogRowLinks,
): LogRowView => {
	const pinned = new Set(pinnedColumns)
	const body = stripAnsi(log.body)
	const lines = Str.split("\n")(body)
	const severity = Str.toUpperCase(severityLabel(log.severityText, log.severityNumber))
	const timeMs = new Date(warehouseDateTimeToIso(log.timestamp)).getTime()
	const compact = formatWith(time.compact, timeMs)
	const clock = Option.match(Str.lastIndexOf(".")(compact), {
		onNone: () => ({ main: compact, fraction: "" }),
		onSome: (dot) => ({ main: Str.slice(0, dot)(compact), fraction: Str.slice(dot)(compact) }),
	})
	const chips = Arr.map(
		Arr.filter(
			pickImportantAttributes(log, Number.POSITIVE_INFINITY),
			(attr) =>
				attr.source === "log" &&
				!pinned.has(attr.key) &&
				!(attr.value.length >= 3 && Str.includes(attr.value)(log.body)),
		).slice(0, MAX_INLINE_CHIPS),
		(attr) => {
			const isJson = isJsonValue(attr.value)
			return {
				...attr,
				displayKey: shortKey(attr.key),
				displayValue: isJson ? "{…}" : truncateValue(attr.value),
				isJson,
			}
		},
	)
	return {
		timeMain: clock.main,
		timeFraction: clock.fraction,
		timeMs,
		timeZone: time.timeZone,
		severity,
		severityColor: getSeverityColor(severity),
		serviceName: log.serviceName,
		serviceColor: getServiceColor(log.serviceName),
		body,
		firstLine: lines[0] ?? "",
		hiddenLinesLabel: lines.length > 1 ? countLabel(lines.length - 1, "line") : "",
		rawBody: log.body,
		traceHref: log.traceId === undefined || log.traceId === "" ? "" : links.trace(log.traceId),
		logHref: Option.match(links.log, { onNone: () => "", onSome: (href) => href(encodeLogKey(log)) }),
		pinned: Arr.map(pinnedColumns, (key) => {
			const value = log.logAttributes[key] ?? log.resourceAttributes[key] ?? EMPTY_VALUE
			const isEmpty = value === EMPTY_VALUE
			return {
				key,
				value,
				isEmpty,
				isNumeric: !isEmpty && Str.trim(value) !== "" && !Number.isNaN(Number(value)),
			}
		}),
		chips,
		log,
	}
}
