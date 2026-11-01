// Cancellation evidence
//
// What a cancelling org sent and did in the 60 days before it cancelled, as
// aggregates the cancellation review hands its model. Every query takes
// `startTime`, `endTime` and, where it splits the window into the review's
// `prior` and `recent` 30 days, `splitTime` (`[startTime, splitTime)` is prior,
// `[splitTime, endTime]` recent).

import * as CH from "@maple-dev/effect-orm/expr"
import { defineCondFn, defineFn, from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { utcHourFloor } from "./query-helpers"
import {
	AlertChecks,
	AttributeValuesHourly,
	AuditLog,
	ErrorEventsByTime,
	ProductEvents,
	ServiceUsage,
	orgIdParam,
	utcSecondsParam,
} from "../tables"

const DAY_SECONDS = 86_400

type UsageColumns = ColumnAccessor<typeof ServiceUsage.columns>

// `service_usage` is keyed on top-of-hour `Hour`: bounds snap to their hour,
// the same correction `serviceUsageQuery` makes.
const usageRecent = ($: UsageColumns) => $.Hour.gte(utcHourFloor("splitTime"))
const usagePrior = ($: UsageColumns) => $.Hour.lt(utcHourFloor("splitTime"))
const usageWindow = ($: UsageColumns) => [
	$.OrgId.eq(orgIdParam),
	$.Hour.gte(utcHourFloor("startTime")),
	$.Hour.lte(utcHourFloor("endTime")),
]
const metricBytes = ($: UsageColumns) =>
	$.SumMetricSizeBytes.add($.GaugeMetricSizeBytes)
		.add($.HistogramMetricSizeBytes)
		.add($.ExpHistogramMetricSizeBytes)

/**
 * The org's largest services over the window, by billable bytes, with each
 * window's bytes per signal, the first and last hour seen and the days active.
 */
export function cancellationServiceUsageQuery(opts: { readonly limit: number }) {
	return from(ServiceUsage)
		.select(($) => ({
			serviceName: $.ServiceName,
			recentTraceBytes: CH.sumIf($.TraceSizeBytes, usageRecent($)),
			recentLogBytes: CH.sumIf($.LogSizeBytes, usageRecent($)),
			recentMetricBytes: CH.sumIf(metricBytes($), usageRecent($)),
			priorTraceBytes: CH.sumIf($.TraceSizeBytes, usagePrior($)),
			priorLogBytes: CH.sumIf($.LogSizeBytes, usagePrior($)),
			priorMetricBytes: CH.sumIf(metricBytes($), usagePrior($)),
			totalBytes: CH.sum($.TraceSizeBytes.add($.LogSizeBytes).add(metricBytes($))),
			firstHour: CH.min_($.Hour),
			lastHour: CH.max_($.Hour),
			activeDaysRecent: CH.uniqIf(CH.toStartOfInterval($.Hour, DAY_SECONDS), usageRecent($)),
			activeDaysPrior: CH.uniqIf(CH.toStartOfInterval($.Hour, DAY_SECONDS), usagePrior($)),
		}))
		.where(usageWindow)
		.groupBy("serviceName")
		.orderBy(["totalBytes", "desc"], ["serviceName", "asc"])
		.limit(opts.limit)
		.format("JSON")
}

/** How many services sent anything in each window. */
export function cancellationServiceCountsQuery() {
	return from(ServiceUsage)
		.select(($) => ({
			distinctRecent: CH.uniqIf($.ServiceName, usageRecent($)),
			distinctPrior: CH.uniqIf($.ServiceName, usagePrior($)),
		}))
		.where(usageWindow)
		.format("JSON")
}

type AttributeColumns = ColumnAccessor<typeof AttributeValuesHourly.columns>

const resourceWindow = ($: AttributeColumns) => [
	$.OrgId.eq(orgIdParam),
	$.AttributeScope.eq("resource"),
	$.Hour.gte(utcHourFloor("startTime")),
	$.Hour.lte(utcHourFloor("endTime")),
]

/** Resource attributes whose values the cancellation review reads. */
export const CANCELLATION_RESOURCE_KEYS = [
	"deployment.environment",
	"deployment.environment.name",
	"telemetry.sdk.language",
	"telemetry.sdk.name",
	"telemetry.sdk.version",
] as const

/**
 * Spans per value of each of {@link CANCELLATION_RESOURCE_KEYS} over the window. The rollup
 * drops empty values, so a span without the attribute is the gap between a
 * key's total and {@link cancellationResourceSpansQuery}.
 */
export function cancellationResourceAttributesQuery(opts: { readonly limit: number }) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeKey: $.AttributeKey,
			attributeValue: $.AttributeValue,
			spans: CH.sum($.UsageCount),
		}))
		.where(($) => [...resourceWindow($), CH.inList($.AttributeKey, CANCELLATION_RESOURCE_KEYS)])
		.groupBy("attributeKey", "attributeValue")
		.orderBy(["spans", "desc"], ["attributeKey", "asc"], ["attributeValue", "asc"])
		.limit(opts.limit)
		.format("JSON")
}

/** The window's spans, counted from the same rollup: every span carries `service.name`. */
export function cancellationResourceSpansQuery() {
	return from(AttributeValuesHourly)
		.select(($) => ({ spans: CH.sum($.UsageCount) }))
		.where(($) => [...resourceWindow($), $.AttributeKey.eq("service.name")])
		.format("JSON")
}

/**
 * The org's alert evaluations in the window by status, skip reason and error
 * class, with the rules behind each. Pinned to the managed route, where the
 * alerting worker writes the table.
 */
export function cancellationAlertChecksQuery() {
	return from(AlertChecks)
		.select(($) => ({
			status: $.Status,
			skipReason: $.SkipReason,
			errorCategory: $.ErrorCategory,
			checks: CH.count(),
			ruleIds: CH.groupUniqArray($.RuleId),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("status", "skipReason", "errorCategory")
		.orderBy(["checks", "desc"])
		.format("JSON")
		.route("ingest")
}

/** Error events per UTC day over the window. */
export function cancellationErrorsByDayQuery() {
	return from(ErrorEventsByTime)
		.select(($) => ({
			day: CH.toStartOfInterval($.Timestamp, DAY_SECONDS),
			errors: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lte(utcSecondsParam("endTime")),
		])
		.groupBy("day")
		.orderBy(["day", "asc"])
		.format("JSON")
}

/** Distinct error fingerprints (kinds of error) in each window. */
export function cancellationErrorFingerprintsQuery() {
	return from(ErrorEventsByTime)
		.select(($) => ({
			distinctRecent: CH.uniqIf($.FingerprintHash, $.Timestamp.gte(utcSecondsParam("splitTime"))),
			distinctPrior: CH.uniqIf($.FingerprintHash, $.Timestamp.lt(utcSecondsParam("splitTime"))),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lte(utcSecondsParam("endTime")),
		])
		.format("JSON")
}

/**
 * Custom and server-side product events (no page or screen views) one group
 * recorded under the org reading them, per name and source: an annotated span
 * lands once as `server` and once more as `trace`, so the caller merges them.
 */
export function cancellationProductEventsQuery(opts: { readonly limit: number }) {
	const recent = ($: ColumnAccessor<typeof ProductEvents.columns>) =>
		$.Timestamp.gte(param.dateTime("splitTime"))
	return from(ProductEvents)
		.select(($) => ({
			eventName: $.EventName,
			source: $.Source,
			recent: CH.countIf(recent($)),
			prior: CH.countIf(CH.not(recent($))),
			lastAt: CH.max_($.Timestamp),
			events: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.GroupId.eq(param.string("groupId")),
			$.Kind.eq("custom"),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("eventName", "source")
		.orderBy(["events", "desc"], ["eventName", "asc"], ["source", "asc"])
		.limit(opts.limit)
		.format("JSON")
}

type AuditColumns = ColumnAccessor<typeof AuditLog.columns>

const auditRecent = ($: AuditColumns) => $.OccurredAt.gte(param.dateTime("splitTime"))
const auditWindow = ($: AuditColumns) => [
	$.OrgId.eq(orgIdParam),
	$.OccurredAt.gte(param.dateTime("startTime")),
	$.OccurredAt.lte(param.dateTime("endTime")),
]
/** The org's own users, API keys and agents: `system` is Maple acting on its own. */
const byCustomer = ($: AuditColumns) => $.ActorType.neq("system")

/** The org's audit-log entries over the window per actor type (`user`, `api_key`, `agent`, `system`). */
export function cancellationAuditActorsQuery() {
	return from(AuditLog)
		.select(($) => ({
			actorType: $.ActorType,
			recent: CH.countIf(auditRecent($)),
			prior: CH.countIf(CH.not(auditRecent($))),
		}))
		.where(auditWindow)
		.groupBy("actorType")
		.orderBy(["actorType", "asc"])
		.format("JSON")
		.route("ingest")
}

/**
 * The org's audit-log actions over the window by its own actors, reads and
 * tool calls included, most frequent first.
 */
export function cancellationAuditActionsQuery(opts: { readonly limit: number }) {
	return from(AuditLog)
		.select(($) => ({
			action: $.Action,
			recent: CH.countIf(auditRecent($)),
			prior: CH.countIf(CH.not(auditRecent($))),
			denied: CH.countIf($.Outcome.neq("allowed")),
			entries: CH.count(),
		}))
		.where(($) => [...auditWindow($), byCustomer($)])
		.groupBy("action")
		.orderBy(["entries", "desc"], ["action", "asc"])
		.limit(opts.limit)
		.format("JSON")
		.route("ingest")
}

const jsonString = defineFn<[CH.Expr<string>, string], string>("JSONExtractString", T.string)
const jsonTrue = defineCondFn<[CH.Expr<string>, string]>("JSONExtractBool")

/** The org's own Maple AI tool calls over the window per tool and surface, most called first. */
export function cancellationToolCallsQuery(opts: { readonly limit: number }) {
	return from(AuditLog)
		.select(($) => ({
			tool: jsonString($.Metadata, "tool"),
			surface: jsonString($.Metadata, "surface"),
			recent: CH.countIf(auditRecent($)),
			prior: CH.countIf(CH.not(auditRecent($))),
			errors: CH.countIf(jsonTrue($.Metadata, "is_error")),
			calls: CH.count(),
		}))
		.where(($) => [...auditWindow($), byCustomer($), $.Action.eq("mcp_tool.called")])
		.groupBy("tool", "surface")
		.orderBy(["calls", "desc"], ["tool", "asc"])
		.limit(opts.limit)
		.format("JSON")
		.route("ingest")
}
