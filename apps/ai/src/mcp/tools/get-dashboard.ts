import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { GetDashboardOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { dashboardNotFound, toMcpDashboardError } from "../lib/dashboard-mutations"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "get_dashboard"

export function registerGetDashboardTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Get Dashboard",
		description:
			"Full configuration of one dashboard: every widget with its id, visualization, dataSource, display, layout and any pinned timeRange. Widgets come back in the shape update_dashboard_widget and replace_dashboard_widgets take. Ids from list_dashboards.",
		parameters: Schema.Struct({
			dashboard_id: P.text("Dashboard ID"),
		}),
		output: GetDashboardOutput,
		hints: { readOnly: true },
		phrases: ["Opening a dashboard", "Loading a dashboard"],
		handler: Effect.fn("McpTool.getDashboard")(function* ({ dashboard_id }) {
			const tenant = yield* CurrentMcpTenant
			const persistence = yield* DashboardPersistenceService

			const result = yield* persistence
				.list(tenant.orgId)
				.pipe(Effect.mapError(toMcpDashboardError(TOOL)))

			const dashboard = result.dashboards.find((d) => d.id === dashboard_id)
			if (!dashboard) return yield* dashboardNotFound(dashboard_id)

			return {
				dashboard: {
					id: dashboard.id,
					name: dashboard.name,
					...(dashboard.description === undefined
						? undefined
						: { description: dashboard.description }),
					// Always emit `tags` (even empty) so the JSON round-trips cleanly back through
					// `update_dashboard`'s `dashboard_json` and the incremental widget tools.
					tags: dashboard.tags ? [...dashboard.tags] : [],
					timeRange: dashboard.timeRange,
					widgets: dashboard.widgets.map((w) => ({
						id: w.id,
						visualization: w.visualization,
						dataSource: w.dataSource,
						display: w.display,
						layout: w.layout,
						// Only present when the widget is pinned to its own window; the absence
						// means "follows the dashboard range", so it must not become `undefined`.
						...(w.timeRange ? { timeRange: w.timeRange } : undefined),
					})),
					createdAt: dashboard.createdAt,
					updatedAt: dashboard.updatedAt,
				},
			}
		}),
		render: ({ dashboard }) => {
			const { widgets, ...header } = dashboard
			return {
				title: `Dashboard: ${dashboard.name}`,
				blocks: [
					doc.fields([
						["ID", dashboard.id],
						["Widgets", widgets.length],
						["Created", dashboard.createdAt.slice(0, 19)],
						["Updated", dashboard.updatedAt.slice(0, 19)],
					]),
					...(widgets.length === 0
						? []
						: [
								doc.table(
									["Widget", "Visualization", "Title"],
									widgets.map((w) => [w.id, w.visualization, w.display.title ?? ""]),
								),
							]),
					// Compact, one widget per line: a long dashboard is cut on whole widgets, never mid-object.
					doc.text(
						"Configuration preview, one JSON value per line: the dashboard fields, then each widget in the " +
							"shape update_dashboard_widget and replace_dashboard_widgets take. This is not a single document: " +
							"for update_dashboard's dashboard_json, use structuredContent.dashboard or rebuild one object " +
							"from the first line plus a `widgets` array of the widget lines.",
					),
					doc.code(
						"json",
						[JSON.stringify(header), ...widgets.map((w) => JSON.stringify(w))].join("\n"),
					),
				],
				next: dashboard.widgets
					.slice(0, 1)
					.map((w) =>
						doc.next(
							"inspect_chart_data",
							{ dashboard_id: dashboard.id, widget_id: w.id },
							"check the data a widget renders",
						),
					),
			}
		},
	})
}
