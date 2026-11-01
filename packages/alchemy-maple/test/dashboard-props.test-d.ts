import { Dashboard, DashboardData, DashboardWidget } from "../src/index"

const widget = DashboardWidget.make({
	id: "requests",
	visualization: "stat",
	data_source: {
		kind: "raw_sql",
		sql: "SELECT count() AS value FROM traces WHERE $__orgFilter",
		transform: { reduce_to_value: { field: "value", aggregate: "first" } },
	},
	display: { title: "Requests", unit: "number" },
	layout: { x: 0, y: 0, w: 3, h: 4 },
})

export const nativeDashboard = Dashboard("health", {
	dashboardId: "dash_existing",
	name: "Health",
	refresh_interval_seconds: 60,
	time_range: { type: "relative", value: "24h" },
	widgets: [widget],
	variables: [{ name: "service", type: "query", source: { kind: "facet", facet: "service" } }],
})

DashboardData.make({
	name: "Health",
	// @ts-expect-error refresh cadence is the native API's closed set
	refresh_interval_seconds: 17,
})

DashboardWidget.make({
	...widget,
	// @ts-expect-error timeseries is not a persisted visualization
	visualization: "timeseries",
})

DashboardWidget.make({
	...widget,
	// @ts-expect-error raw SQL requires its SQL text
	data_source: { kind: "raw_sql" },
})

DashboardData.make({
	name: "Health",
	// @ts-expect-error absolute ranges use the native snake_case fields
	time_range: { type: "absolute", startTime: "2026-10-27", endTime: "2026-10-28" },
})
