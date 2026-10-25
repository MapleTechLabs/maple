import type { MetricType } from "@maple/domain/query-engine"
import * as CH from "@maple-dev/effect-orm/expr"
import { param } from "@maple-dev/effect-orm/clickhouse"
import { from, fromQuery, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import {
	AttributeKeysHourly,
	AttributeValuesHourly,
	MetricsSum,
	Traces,
	orgIdParam,
	utcSecondsParam,
} from "../tables"
import { resolveMetricTable } from "./query-helpers"

export interface AttributeKeysQueryOpts {
	scope: string
	limit?: number
	/** Restrict to these exact keys, to check presence without relying on the top-N list. */
	keys?: readonly string[]
}

export interface AttributeKeysOutput {
	readonly attributeKey: string
	readonly usageCount: number
}

export function attributeKeysQuery(opts: AttributeKeysQueryOpts) {
	return from(AttributeKeysHourly)
		.select(($) => ({
			attributeKey: $.AttributeKey,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
			$.AttributeScope.eq(opts.scope),
			opts.keys ? CH.inList($.AttributeKey, opts.keys) : undefined,
		])
		.groupBy("attributeKey")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

// Attribute values queries

export interface AttributeValuesOpts {
	attributeKey: string
	limit?: number
}

export interface AttributeValuesOutput {
	readonly attributeValue: string
	readonly usageCount: number
}

export function spanAttributeValuesQuery(opts: AttributeValuesOpts) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
			$.AttributeScope.eq("span"),
			$.AttributeKey.eq(opts.attributeKey),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

export function resourceAttributeValuesQuery(opts: AttributeValuesOpts) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
			$.AttributeScope.eq("resource"),
			$.AttributeKey.eq(opts.attributeKey),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

export function logAttributeValuesQuery(opts: AttributeValuesOpts) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
			$.AttributeScope.eq("log"),
			$.AttributeKey.eq(opts.attributeKey),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

// Metric-scoped attribute discovery — reads the raw metric tables so keys and
// values are filtered to a single metric. The hourly rollups above have no
// MetricName column (and only materialize from metrics_sum), so per-metric
// scoping must scan the raw table for the metric's type.

export interface MetricScopedAttributeKeysOpts {
	metricType: MetricType
	serviceName?: string
	limit?: number
}

export function metricScopedAttributeKeysQuery(opts: MetricScopedAttributeKeysOpts) {
	const { tbl } = resolveMetricTable(opts.metricType)
	return from(tbl as typeof MetricsSum)
		.select(($) => ({
			attributeKey: CH.arrayJoin(CH.mapKeys($.Attributes)),
			usageCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.MetricName.eq(param.string("metricName")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		])
		.groupBy("attributeKey")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

export interface MetricScopedAttributeValuesOpts {
	metricType: MetricType
	attributeKey: string
	/** `resource` reads `ResourceAttributes`; absent or `metric` reads the data-point `Attributes`. */
	scope?: "metric" | "resource"
	/** Several metrics of `metricType` in place of the `metricName` param. */
	metricNames?: ReadonlyArray<string>
	serviceName?: string
	limit?: number
}

export function metricScopedAttributeValuesQuery(opts: MetricScopedAttributeValuesOpts) {
	const { tbl } = resolveMetricTable(opts.metricType)
	const attributeValue = ($: ColumnAccessor<typeof MetricsSum.columns>) =>
		opts.scope === "resource"
			? $.ResourceAttributes.get(opts.attributeKey)
			: $.Attributes.get(opts.attributeKey)
	return from(tbl as typeof MetricsSum)
		.select(($) => ({
			attributeValue: attributeValue($),
			usageCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			opts.metricNames
				? CH.inList($.MetricName, opts.metricNames)
				: $.MetricName.eq(param.string("metricName")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			attributeValue($).neq(""),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

export function metricAttributeValuesQuery(opts: AttributeValuesOpts) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
			$.AttributeScope.eq("metric"),
			$.AttributeKey.eq(opts.attributeKey),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

// Service-scoped trace attribute discovery. The hourly rollups carry no
// ServiceName, so these read raw `traces` for one service, capped at
// `SERVICE_SCOPED_SPAN_SAMPLE` spans. No ORDER BY: the bare LIMIT stops the read early.

export const SERVICE_SCOPED_SPAN_SAMPLE = 20_000

export interface ServiceScopedAttributeOpts {
	scope: "span" | "resource"
	limit?: number
}

const serviceSpanSample = (scope: "span" | "resource") =>
	from(Traces)
		.select(($) => ({
			attrs: scope === "resource" ? $.ResourceAttributes : $.SpanAttributes,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.ServiceName.eq(param.string("serviceName")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.limit(SERVICE_SCOPED_SPAN_SAMPLE)

export function serviceScopedAttributeKeysQuery(opts: ServiceScopedAttributeOpts) {
	return fromQuery(serviceSpanSample(opts.scope), "sampled")
		.select(($) => ({
			attributeKey: CH.arrayJoin(CH.mapKeys($.attrs)),
			usageCount: CH.count(),
		}))
		.groupBy("attributeKey")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

export function serviceScopedAttributeValuesQuery(
	opts: ServiceScopedAttributeOpts & { attributeKey: string },
) {
	return fromQuery(serviceSpanSample(opts.scope), "sampled")
		.select(($) => ({
			attributeValue: CH.mapGet($.attrs, opts.attributeKey),
			usageCount: CH.count(),
		}))
		.where(($) => [CH.mapGet($.attrs, opts.attributeKey).neq("")])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}
