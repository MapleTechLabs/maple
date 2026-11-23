// What a draft ingest rule's conditions would have matched in stored logs and spans: the
// settings dry run. The gateway evaluates rules on OTLP records; this is the same test written
// against the warehouse columns, so it is an estimate (RE2 instead of Rust's regex, attribute
// values already stringified by ingest, data the org's other rules dropped is not there).

import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { SEVERITY_LEVELS, type IngestRuleCondition } from "@maple/domain/ingest-rules"
import { Array as Arr, Option, pipe, Record as Rec, String as Str } from "effect"
import { orgIdParam, utcSecondsParam } from "../tables"
import { utcHourFloor } from "./query-helpers"

/** The gateway scans at most this much of a value with a regex. */
const REGEX_WINDOW = 16 * 1024

type StringExpr = CH.Expr<string>

/** The head of a value a regex sees; counted in characters, so the cut never splits one. */
const regexWindow = (value: StringExpr) =>
	CH.compileTypedFnCall("leftUTF8", T.string.schema, value, CH.lit(REGEX_WINDOW))

/** Long General_Category names JS accepts in `\\p{...}`; RE2 takes only the short ones. */
const CATEGORY_SHORT_NAMES = {
	Letter: "L",
	Cased_Letter: "LC",
	Uppercase_Letter: "Lu",
	Lowercase_Letter: "Ll",
	Titlecase_Letter: "Lt",
	Modifier_Letter: "Lm",
	Other_Letter: "Lo",
	Mark: "M",
	Number: "N",
	Decimal_Number: "Nd",
	Letter_Number: "Nl",
	Other_Number: "No",
	Punctuation: "P",
	Symbol: "S",
	Separator: "Z",
	Space_Separator: "Zs",
	Other: "C",
	Control: "Cc",
} as const satisfies Record<string, string>

/** Rust's Unicode classes, which RE2 writes differently (its `\\d`, `\\w`, `\\s` are ASCII only). */
const WORD = "\\p{L}\\p{Nl}\\p{M}\\p{Nd}\\p{Pc}"
const SPACE =
	"\\t\\n\\x{0B}\\f\\r \\x{85}\\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}"
const IN_CLASS = { d: "\\p{Nd}", w: WORD, s: SPACE } as const satisfies Record<string, string>
const OUTSIDE_CLASS = {
	d: "\\p{Nd}",
	D: "\\P{Nd}",
	w: `[${WORD}]`,
	W: `[^${WORD}]`,
	s: `[${SPACE}]`,
	S: `[^${SPACE}]`,
} as const satisfies Record<string, string>

/**
 * `\\d`, `\\w`, `\\s` and their negations as the Unicode classes the gateway means, read
 * escape by escape so `\\\\d` stays a backslash and a `d`. The validator keeps the negations out
 * of `[...]`.
 */
const unicodeShorthands = (pattern: string): string =>
	Arr.reduce(Str.split("")(pattern), { out: "", escaped: false, inClass: false }, (state, char) => {
		if (state.escaped) {
			const table: ReadonlyArray<readonly [string, string]> = state.inClass
				? Rec.toEntries(IN_CLASS)
				: Rec.toEntries(OUTSIDE_CLASS)
			const replaced = Option.match(
				Arr.findFirst(table, ([shorthand]) => shorthand === char),
				{ onNone: () => `\\${char}`, onSome: ([, unicode]) => unicode },
			)
			return { ...state, escaped: false, out: state.out + replaced }
		}
		if (char === "\\") return { ...state, escaped: true }
		const inClass = state.inClass ? char !== "]" : char === "["
		return { ...state, inClass, out: state.out + char }
	}).out

/**
 * A validated rule pattern in ClickHouse's RE2 dialect, meaning what the gateway means. Shorthand
 * classes become Unicode classes, `.` stops at a newline (ClickHouse lets it cross one), and the
 * spellings RE2 lacks are rewritten: `\\u0041` and `\\u{41}` (RE2 `\\x{41}`), `(?<name>` (RE2
 * `(?P<name>`), `\\p{Script=Greek}` (RE2 `\\p{Greek}`) and `\\p{Letter}` (RE2 `\\p{L}`). `\\b` stays
 * ASCII in RE2, so a word boundary next to a non-ASCII letter can count differently.
 */
export const toRe2 = (pattern: string): string =>
	`(?-s)${Arr.reduce(
		Rec.toEntries(CATEGORY_SHORT_NAMES),
		pipe(
			unicodeShorthands(pattern),
			Str.replace(/(?<!\\)((?:\\\\)*)\\u\{([0-9A-Fa-f]{1,6})\}/gu, "$1\\x{$2}"),
			Str.replace(/(?<!\\)((?:\\\\)*)\\u([0-9A-Fa-f]{4})/gu, "$1\\x{$2}"),
			Str.replace(/\(\?<(?![=!])/gu, "(?P<"),
			Str.replace(
				/\\([pP])\{(?:Script|sc|Script_Extensions|scx|General_Category|gc)=([A-Za-z_]+)\}/gu,
				"\\$1{$2}",
			),
		),
		(text, [long, short]) =>
			Str.replace(new RegExp(`\\\\([pP])\\{${long}\\}`, "gu"), `\\$1{${short}}`)(text),
	)}`

type MapExpr = CH.Expr<Record<string, string>>

/** A string value under one op; `present` says whether the record has it at all. */
const compare = (
	value: StringExpr,
	present: CH.Condition | undefined,
	condition: IngestRuleCondition,
): CH.Condition | undefined => {
	const operand = condition.value ?? ""
	const operands = condition.values ?? []
	const given = (test: CH.Condition) => (present === undefined ? test : CH.and(present, test))
	switch (condition.op) {
		case "eq":
			return given(value.eq(operand))
		case "neq":
			return CH.not(given(value.eq(operand)) ?? CH.rawCond("1"))
		case "in":
			return given(CH.inList(value, operands))
		case "not_in":
			return CH.not(given(CH.inList(value, operands)) ?? CH.rawCond("1"))
		case "prefix":
			return given(value.startsWith(operand))
		case "contains":
			return given(value.contains(operand))
		case "regex":
			return given(CH.matchCond(regexWindow(value), toRe2(operand)))
		case "exists":
			return present ?? CH.rawCond("1")
		case "not_exists":
			return present === undefined ? CH.rawCond("0") : CH.not(present)
		case "lt":
		case "gte":
			return CH.rawCond("0")
	}
}

const mapValue = (map: MapExpr, condition: IngestRuleCondition) => {
	const key = condition.key ?? ""
	return compare(CH.mapGet(map, key), CH.mapContains(map, key), condition)
}

/** `severity_number`, else derived from `severity_text` by prefix as the gateway does; 0 is unknown. */
const severityOf = (number: CH.Expr<number>, text: StringExpr) => {
	const lower = CH.lower_(text)
	return CH.multiIf<number>(
		[
			[number.gt(0), number],
			[lower.startsWith("trace"), CH.lit(SEVERITY_LEVELS.trace)],
			[lower.startsWith("debug"), CH.lit(SEVERITY_LEVELS.debug)],
			[lower.startsWith("info"), CH.lit(SEVERITY_LEVELS.info)],
			[lower.startsWith("warn"), CH.lit(SEVERITY_LEVELS.warn)],
			[lower.startsWith("err"), CH.lit(SEVERITY_LEVELS.error)],
			[
				CH.or(lower.startsWith("fatal"), lower.startsWith("crit"), lower.startsWith("emerg")) ??
					CH.rawCond("0"),
				CH.lit(SEVERITY_LEVELS.fatal),
			],
		],
		CH.lit(0),
	)
}

const severityCondition = (severity: CH.Expr<number>, condition: IngestRuleCondition) => {
	const level = Option.getOrUndefined(
		Option.map(
			Arr.findFirst(Rec.toEntries(SEVERITY_LEVELS), ([name]) => name === condition.value),
			([, number]) => number,
		),
	)
	if (level === undefined) return CH.rawCond("0")
	const known = severity.gt(0)
	return CH.and(known, condition.op === "lt" ? severity.lt(level) : severity.gte(level))
}

const logCondition = (
	$: ColumnAccessor<typeof Datasources.logs.columns>,
	condition: IngestRuleCondition,
): CH.Condition | undefined => {
	switch (condition.field) {
		case "service_name":
			return compare($.ServiceName, undefined, condition)
		case "attribute":
			return mapValue($.LogAttributes, condition)
		case "resource_attribute":
			return mapValue($.ResourceAttributes, condition)
		case "body":
			return compare($.Body, undefined, condition)
		case "severity":
			return severityCondition(severityOf($.SeverityNumber, $.SeverityText), condition)
		default:
			// The validator keeps span-only fields off logs; a stray one matches nothing.
			return CH.rawCond("0")
	}
}

/** `Server` or `SPAN_KIND_SERVER` as the rule's lower-case `server`. */
const spanKindOf = (kind: StringExpr) => CH.lower_(CH.replaceOne(kind, "SPAN_KIND_", ""))
const spanStatusOf = (status: StringExpr) => CH.lower_(CH.replaceOne(status, "STATUS_CODE_", ""))

const spanCondition = (
	$: ColumnAccessor<typeof Datasources.traces.columns>,
	condition: IngestRuleCondition,
): CH.Condition | undefined => {
	switch (condition.field) {
		case "service_name":
			return compare($.ServiceName, undefined, condition)
		case "name":
			return compare($.SpanName, undefined, condition)
		case "attribute":
			return mapValue($.SpanAttributes, condition)
		case "resource_attribute":
			return mapValue($.ResourceAttributes, condition)
		case "span_kind":
			return compare(spanKindOf($.SpanKind), undefined, condition)
		case "span_status":
			return compare(spanStatusOf($.StatusCode), undefined, condition)
		default:
			return CH.rawCond("0")
	}
}

export interface IngestRuleMatchOpts {
	readonly conditions: ReadonlyArray<IngestRuleCondition>
}

/** Stored logs per service over the window, and how many every condition matches. */
export function ingestRuleLogMatchesQuery(opts: IngestRuleMatchOpts) {
	return from(Datasources.logs)
		.select(($) => ({
			serviceName: $.ServiceName,
			total: CH.count(),
			matched: CH.countIf(
				CH.and(...Arr.map(opts.conditions, (condition) => logCondition($, condition))) ??
					CH.rawCond("1"),
			),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.TimestampTime.gte(utcSecondsParam("startTime")),
			$.TimestampTime.lte(utcSecondsParam("endTime")),
		])
		.groupBy("serviceName")
		.format("JSON")
}

/** Stored spans per service over the window, and how many every condition matches. */
export function ingestRuleSpanMatchesQuery(opts: IngestRuleMatchOpts) {
	return from(Datasources.traces)
		.select(($) => ({
			serviceName: $.ServiceName,
			total: CH.count(),
			matched: CH.countIf(
				CH.and(...Arr.map(opts.conditions, (condition) => spanCondition($, condition))) ??
					CH.rawCond("1"),
			),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName")
		.format("JSON")
}

/** Stored logs and spans per UTC hour bucket the window touches, newest first: sizes a scan. */
export function ingestRuleHourlyVolumeQuery() {
	return from(Datasources.serviceUsage)
		.select(($) => ({
			hour: $.Hour,
			logs: CH.sum($.LogCount),
			spans: CH.sum($.TraceCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcHourFloor("endTime")),
		])
		.groupBy("hour")
		.orderBy(["hour", "desc"])
		.format("JSON")
}
