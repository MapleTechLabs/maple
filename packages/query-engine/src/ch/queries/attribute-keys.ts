import type { MetricType } from "@maple/domain/query-engine"
import * as CH from "@maple-dev/effect-clickhouse/expr"
import { param } from "@maple-dev/effect-clickhouse"
import { from, fromQuery } from "@maple-dev/effect-clickhouse"
import { AttributeKeysHourly, AttributeValuesHourly, MetricsSum, Traces } from "../tables"
import { resolveMetricTable } from "./query-helpers"

export interface AttributeKeysQueryOpts {
	scope: string
	limit?: number
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
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTimeSeconds("startTime")),
			$.Hour.lte(param.dateTimeSeconds("endTime")),
			$.AttributeScope.eq(opts.scope),
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
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTimeSeconds("startTime")),
			$.Hour.lte(param.dateTimeSeconds("endTime")),
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
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTimeSeconds("startTime")),
			$.Hour.lte(param.dateTimeSeconds("endTime")),
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
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTimeSeconds("startTime")),
			$.Hour.lte(param.dateTimeSeconds("endTime")),
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
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.eq(param.string("metricName")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
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
	serviceName?: string
	limit?: number
}

export function metricScopedAttributeValuesQuery(opts: MetricScopedAttributeValuesOpts) {
	const { tbl } = resolveMetricTable(opts.metricType)
	return from(tbl as typeof MetricsSum)
		.select(($) => ({
			attributeValue: $.Attributes.get(opts.attributeKey),
			usageCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.eq(param.string("metricName")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.Attributes.get(opts.attributeKey).neq(""),
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
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTimeSeconds("startTime")),
			$.Hour.lte(param.dateTimeSeconds("endTime")),
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
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
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
