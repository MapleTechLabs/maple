import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_BAR,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	makeQueryDraft,
	metricsTimeseries,
	paramKey,
	paramValue,
	templateId,
} from "@/dashboard-templates/helpers"
import type { TemplateDefinition, WidgetDef } from "@/dashboard-templates/types"

// GA4 metrics land under ServiceName `google-analytics/{propertyId}` (the
// GoogleAnalyticsService collector).
//
// EVERY widget here uses `sum`, and that is not a stylistic choice. These are
// DELTA-temporality sums — each row is one hour's increment, reconciled against the ledger so a
// revised hour arrives as a difference. `rate` and `increase` assume CUMULATIVE temporality and
// reconstruct increments with `lagInFrame`, so pointing either at these metrics
// double-differences the data (see packages/query-engine/src/query-builder/model.ts).
//
// The `.by_*` suffixes matter too: `channels`, `geo` and `device` each report the same session
// total sliced differently, so they are separate metrics rather than one metric with three
// attributes. Charting `google_analytics.sessions` never double-counts as a result.
/**
 * GA4 property IDs are decimal, and this is interpolated into a filter expression — so anything
 * else is rejected rather than embedded. A value carrying a quote would close the string early and
 * leave an unparseable clause, and a clause the builder cannot parse is dropped, which would
 * silently widen every widget from one property to ALL of them. Failing the parameter is the only
 * safe response; an unfiltered dashboard is not a degraded result, it is the wrong one.
 */
const GA4_PROPERTY_ID = /^[0-9]+$/

function propertyWhere(propertyId?: string): string {
	if (propertyId === undefined || propertyId === "") return ""
	if (!GA4_PROPERTY_ID.test(propertyId)) {
		throw new Error(`Google Analytics property must be a numeric GA4 property ID, got "${propertyId}"`)
	}
	return `service.name = "google-analytics/${propertyId}"`
}

/** A single-metric stat: reduce one query-builder series to one number. */
function metricStat(opts: {
	id: string
	name: string
	metricName: string
	where: string
	unit: string
	title: string
	layout: WidgetDef["layout"]
}): WidgetDef {
	return {
		id: opts.id,
		visualization: "stat",
		dataSource: {
			...metricsTimeseries({
				id: opts.id,
				name: opts.name,
				metricName: opts.metricName,
				metricType: "sum",
				aggregation: "sum",
				whereClause: opts.where,
			}),
			transform: { reduceToValue: { field: opts.name, aggregate: "sum" } },
		},
		display: { title: opts.title, unit: opts.unit },
		layout: opts.layout,
	}
}

/** A top-N breakdown: one series per attribute value, ranked by total over the window. */
function breakdownChart(opts: {
	id: string
	name: string
	metricName: string
	attribute: string
	where: string
	title: string
	layout: WidgetDef["layout"]
	display: typeof CHART_DISPLAY_BAR | typeof CHART_DISPLAY_AREA
}): WidgetDef {
	return {
		id: opts.id,
		visualization: "chart",
		dataSource: metricsTimeseries({
			id: opts.id,
			name: opts.name,
			metricName: opts.metricName,
			metricType: "sum",
			aggregation: "sum",
			whereClause: opts.where,
			groupBy: [`attr.${opts.attribute}`],
		}),
		display: { title: opts.title, ...opts.display, unit: "number" },
		layout: opts.layout,
	}
}

function widgets(propertyId?: string): WidgetDef[] {
	const where = propertyWhere(propertyId)
	return [
		metricStat({
			id: "kpi-sessions",
			name: "Sessions",
			metricName: "google_analytics.sessions",
			where,
			unit: "number",
			title: "Sessions",
			layout: { x: 0, y: 0, w: 3, h: 2 },
		}),
		metricStat({
			id: "kpi-active-users",
			name: "Active users",
			metricName: "google_analytics.active_users",
			where,
			unit: "number",
			title: "Active Users",
			layout: { x: 3, y: 0, w: 3, h: 2 },
		}),
		metricStat({
			id: "kpi-new-users",
			name: "New users",
			metricName: "google_analytics.new_users",
			where,
			unit: "number",
			title: "New Users",
			layout: { x: 6, y: 0, w: 3, h: 2 },
		}),
		metricStat({
			id: "kpi-page-views",
			name: "Page views",
			metricName: "google_analytics.page_views",
			where,
			unit: "number",
			title: "Page Views",
			layout: { x: 9, y: 0, w: 3, h: 2 },
		}),

		{
			id: "traffic-over-time",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "ga-sessions-over-time",
				name: "Sessions",
				metricName: "google_analytics.sessions",
				metricType: "sum",
				aggregation: "sum",
				whereClause: where,
			}),
			display: { title: "Sessions Over Time", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 2, w: 6, h: 6 },
		},
		{
			id: "engagement-over-time",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "ga-engaged-sessions",
				name: "Engaged sessions",
				metricName: "google_analytics.engaged_sessions",
				metricType: "sum",
				aggregation: "sum",
				whereClause: where,
			}),
			display: { title: "Engaged Sessions", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 2, w: 6, h: 6 },
		},

		breakdownChart({
			id: "sessions-by-channel",
			name: "Sessions",
			metricName: "google_analytics.sessions.by_channel",
			attribute: "google_analytics.channel_group",
			where,
			title: "Sessions by Channel",
			display: CHART_DISPLAY_AREA,
			layout: { x: 0, y: 8, w: 6, h: 6 },
		}),
		breakdownChart({
			id: "page-views-by-page",
			name: "Page views",
			metricName: "google_analytics.page_views.by_page",
			attribute: "url.path",
			where,
			title: "Page Views by Path",
			display: CHART_DISPLAY_BAR,
			layout: { x: 6, y: 8, w: 6, h: 6 },
		}),
		breakdownChart({
			id: "sessions-by-country",
			name: "Sessions",
			metricName: "google_analytics.sessions.by_country",
			attribute: "geo.country_iso_code",
			where,
			title: "Sessions by Country",
			display: CHART_DISPLAY_BAR,
			layout: { x: 0, y: 14, w: 4, h: 6 },
		}),
		breakdownChart({
			id: "sessions-by-device",
			name: "Sessions",
			metricName: "google_analytics.sessions.by_device",
			attribute: "google_analytics.device_category",
			where,
			title: "Sessions by Device",
			display: CHART_DISPLAY_AREA,
			layout: { x: 4, y: 14, w: 4, h: 6 },
		}),
		breakdownChart({
			id: "key-events-by-name",
			name: "Key events",
			metricName: "google_analytics.key_events.by_event",
			attribute: "google_analytics.event_name",
			where,
			title: "Key Events (Conversions)",
			display: CHART_DISPLAY_BAR,
			layout: { x: 8, y: 14, w: 4, h: 6 },
		}),
	]
}

export const googleAnalyticsTemplate: TemplateDefinition = {
	id: templateId("google-analytics"),
	name: "Google Analytics",
	description:
		"Web analytics from the Google Analytics integration — sessions, users and page views, traffic and engagement over time, plus breakdowns by channel, page, country, device and key event.",
	category: "product",
	tags: ["google-analytics", "web", "marketing"],
	requirement: {
		kind: "integration",
		label: "Google Analytics integration connected",
		missing: "not connected",
		collector: "the Google Analytics integration",
		setupLabel: "the Google Analytics integration",
		hint: "Connect a Google account with access to a GA4 property and every widget fills in on its own.",
	},
	requiredMetricPrefixes: ["google_analytics."],
	parameters: [
		{
			key: paramKey("property_id"),
			label: "Property",
			description: "Optional — scope every widget to a single GA4 property.",
			required: false,
			placeholder: "123456789",
		},
	],
	build: (params) => {
		const propertyId = paramValue(params, "property_id")
		return buildPortableDashboard({
			name: propertyId ? `${propertyId} — Google Analytics` : "Google Analytics",
			description:
				"Google Analytics 4 — sessions, users, page views, and breakdowns by channel, page, country and device.",
			tags: ["google-analytics"],
			timeRange: "24h",
			widgets: widgets(propertyId),
		})
	},
}
