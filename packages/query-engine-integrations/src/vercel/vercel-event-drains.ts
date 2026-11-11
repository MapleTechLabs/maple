// Vercel Speed Insights, Web Analytics and audit log (/infra/vercel)
//
// Each drain lands in `logs` under its own service (ingest maps them in
// `apps/ingest/src/vercel_event_drains.rs`), one record per event, the project on
// resource `vercel.project.id` (empty for team events). Filtering on the service
// prunes on the logs sort key.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam, utcSecondsParam } from "@maple/query-engine/ch/tables"
import { finiteOrZero } from "@maple/query-engine/ch/format"
import type { VercelProjectScope } from "./vercel-infra"

type LogColumns = ColumnAccessor<typeof Datasources.logs.columns>

const SPEED_INSIGHTS_SERVICE = "vercel-speed-insights"
const WEB_ANALYTICS_SERVICE = "vercel-web-analytics"
const AUDIT_LOG_SERVICE = "vercel-audit-log"

const drainWhere = ($: LogColumns, service: string, scope: VercelProjectScope) => [
	$.OrgId.eq(orgIdParam),
	$.ServiceName.eq(service),
	$.TimestampTime.gte(utcSecondsParam("startTime")),
	$.TimestampTime.lte(utcSecondsParam("endTime")),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
	CH.when(scope.projectId, (id) => $.ResourceAttributes.get("vercel.project.id").eq(id)),
]

export type VercelSpeedInsightsGroup = "metric" | "route" | "device"

/** One route or device type the Speed Insights readings are narrowed to; the value is a literal. */
export interface VercelSpeedInsightsFilter {
	readonly dimension: "route" | "device"
	readonly value: string
}

const speedInsightsKey = ($: LogColumns, groupBy: VercelSpeedInsightsGroup) => {
	switch (groupBy) {
		case "metric":
			return CH.lit("")
		case "route":
			return CH.if_(
				$.LogAttributes.get("vercel.route").neq(""),
				$.LogAttributes.get("vercel.route"),
				$.LogAttributes.get("url.path"),
			)
		case "device":
			return $.LogAttributes.get("vercel.device.type")
	}
}

/** The 75th percentile of each Web Vital, overall or per route or device type. */
export function vercelSpeedInsightsSQL(
	groupBy: VercelSpeedInsightsGroup,
	scope: VercelProjectScope = {},
	/** Narrows the other groupings; a grouping is never narrowed by its own dimension. */
	filter?: VercelSpeedInsightsFilter,
) {
	return from(Datasources.logs)
		.select(($) => ({
			key: speedInsightsKey($, groupBy),
			metric: $.LogAttributes.get("vercel.speed_insights.metric"),
			p75: finiteOrZero(
				CH.quantile(0.75)(CH.toFloat64OrZero($.LogAttributes.get("vercel.speed_insights.value"))),
			),
			samples: CH.count(),
		}))
		.where(($) => [
			...drainWhere($, SPEED_INSIGHTS_SERVICE, scope),
			$.LogAttributes.get("vercel.speed_insights.metric").neq(""),
			filter === undefined || filter.dimension === groupBy
				? undefined
				: speedInsightsKey($, filter.dimension).eq(filter.value),
		])
		.groupBy("key", "metric")
		.orderBy(["samples", "desc"])
		.limit(200)
		.format("JSON")
}

const eventType = ($: LogColumns) => $.LogAttributes.get("vercel.web_analytics.event.type")
const deviceId = ($: LogColumns) => $.LogAttributes.get("vercel.web_analytics.device_id")
const isPageView = ($: LogColumns) => eventType($).eq("pageview")

/** Page views, the devices behind them, and custom events over the window. */
export function vercelWebAnalyticsSummarySQL(
	scope: VercelProjectScope = {},
	filter?: VercelWebAnalyticsFilter,
) {
	return from(Datasources.logs)
		.select(($) => ({
			pageViews: CH.countIf(isPageView($)),
			uniqueDevices: CH.uniqIf(deviceId($), isPageView($).and(deviceId($).neq(""))),
			customEvents: CH.countIf(eventType($).eq("event")),
		}))
		.where(($) => [
			...drainWhere($, WEB_ANALYTICS_SERVICE, scope),
			CH.when(filter, (f) => webAnalyticsValue($, f.dimension).eq(f.value)),
		])
		.format("JSON")
}

export type VercelWebAnalyticsDimension = "page" | "referrer" | "country" | "event"

/**
 * One page, referrer or country the Web Analytics reads are narrowed to; the value is a literal.
 * Not a custom event: page views and events are separate records with nothing joining them.
 */
export interface VercelWebAnalyticsFilter {
	readonly dimension: "page" | "referrer" | "country"
	readonly value: string
}

const webAnalyticsValue = ($: LogColumns, dimension: VercelWebAnalyticsDimension) => {
	switch (dimension) {
		case "page":
			return $.LogAttributes.get("url.path")
		case "referrer":
			return $.LogAttributes.get("http.request.header.referer")
		case "country":
			return $.LogAttributes.get("geo.country.iso_code")
		case "event":
			return $.LogAttributes.get("vercel.web_analytics.event.name")
	}
}

/** The ten most viewed pages, referrers or countries, or the ten most frequent custom events. */
export function vercelWebAnalyticsTopSQL(
	dimension: VercelWebAnalyticsDimension,
	scope: VercelProjectScope = {},
	/** Narrows the other tables; a table is never narrowed by its own dimension. */
	filter?: VercelWebAnalyticsFilter,
) {
	return from(Datasources.logs)
		.select(($) => ({
			value: webAnalyticsValue($, dimension),
			count: CH.count(),
			devices: CH.uniqIf(deviceId($), deviceId($).neq("")),
		}))
		.where(($) => [
			...drainWhere($, WEB_ANALYTICS_SERVICE, scope),
			dimension === "event" ? eventType($).eq("event") : isPageView($),
			webAnalyticsValue($, dimension).neq(""),
			filter === undefined || filter.dimension === dimension
				? undefined
				: webAnalyticsValue($, filter.dimension).eq(filter.value),
		])
		.groupBy("value")
		.orderBy(["count", "desc"])
		.limit(10)
		.format("JSON")
}

/** The team's newest audit events. */
export function vercelAuditLogSQL() {
	return from(Datasources.logs)
		.select(($) => ({
			timestamp: $.Timestamp,
			action: $.LogAttributes.get("vercel.audit.action"),
			actor: CH.if_(
				$.LogAttributes.get("vercel.audit.actor.name").neq(""),
				$.LogAttributes.get("vercel.audit.actor.name"),
				$.LogAttributes.get("vercel.audit.actor.id"),
			),
			actorType: $.LogAttributes.get("vercel.audit.actor.type"),
			projectId: $.ResourceAttributes.get("vercel.project.id"),
		}))
		.where(($) => drainWhere($, AUDIT_LOG_SERVICE, {}))
		.orderBy(["timestamp", "desc"])
		.limit(25)
		.format("JSON")
}
