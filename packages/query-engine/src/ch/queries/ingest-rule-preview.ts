// What a draft ingest rule's conditions would have matched in stored logs and spans: the
// settings dry run. The gateway evaluates rules on OTLP records; this is the same test written
// against the warehouse columns, so it is an estimate (RE2 instead of Rust's regex, attribute
// values already stringified by ingest, data the org's other rules dropped is not there).

import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { SEVERITY_LEVELS, type IngestRuleCondition } from "@maple/domain/ingest-rules"
import { Array as Arr } from "effect"
import { orgIdParam, utcSecondsParam } from "../tables"
import { utcHourFloor } from "./query-helpers"

/** The gateway scans at most this much of a value with a regex. */
const REGEX_WINDOW = 16 * 1024

type StringExpr = CH.Expr<string>
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
			return given(CH.matchCond(CH.left_(value, CH.lit(REGEX_WINDOW)), operand))
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
	const level = SEVERITY_LEVELS[(condition.value ?? "") as keyof typeof SEVERITY_LEVELS]
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

// Suggested rules: the busiest log levels and span names per service, from the hourly rollups so
// a day costs a few thousand rows, not a scan.

/** `debug` for trace and debug text, `info` for info, `other` for the rest (unknown included). */
const levelOfText = (text: StringExpr) => {
	const lower = CH.lower_(text)
	return CH.multiIf<string>(
		[
			[CH.or(lower.startsWith("trace"), lower.startsWith("debug")) ?? CH.rawCond("0"), CH.lit("debug")],
			[lower.startsWith("info"), CH.lit("info")],
		],
		CH.lit("other"),
	)
}

/** Stored logs per service and level over the hours the window touches. */
export function ingestRuleLogVolumeQuery() {
	return from(Datasources.logsAggregatesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			level: levelOfText($.SeverityText),
			records: CH.sum($.Count),
			bytes: CH.sum($.SizeBytes),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("serviceName", "level")
		.orderBy(["bytes", "desc"])
		.limit(200)
		.format("JSON")
}

/** Stored spans per service and span name over the hours the window touches, busiest first. */
export function ingestRuleSpanVolumeQuery() {
	return from(Datasources.serviceOperationsHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			spanName: $.SpanName,
			records: CH.sum($.SpanCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("serviceName", "spanName")
		.orderBy(["records", "desc"])
		.limit(200)
		.format("JSON")
}
