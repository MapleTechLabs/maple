import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { RemoveDashboardWidgetOutput } from "@maple/domain/mcp-outputs"
import { toDashboardRow, withDashboardMutation } from "../lib/dashboard-mutations"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "remove_dashboard_widget"

export function registerRemoveDashboardWidgetTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		description:
			"Remove a single widget from a dashboard by id. Other widgets and dashboard metadata are left untouched.",
		parameters: Schema.Struct({
			dashboard_id: P.text("Dashboard ID (ids from list_dashboards)"),
			widget_id: P.text("ID of the widget to remove (get_dashboard lists them)"),
		}),
		output: RemoveDashboardWidgetOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Removing a widget"],
		handler: Effect.fn("McpTool.removeDashboardWidget")(function* ({ dashboard_id, widget_id }) {
			const dashboard = yield* withDashboardMutation(dashboard_id, TOOL, (existingWidgets) =>
				existingWidgets.some((w) => w.id === widget_id)
					? Effect.succeed(existingWidgets.filter((w) => w.id !== widget_id))
					: Effect.fail(
							new McpInvalidInputError({
								message: `Widget not found: ${widget_id}. Use get_dashboard to see existing widget ids.`,
								parameter: "widget_id",
							}),
						),
			)

			return { dashboard: toDashboardRow(dashboard), removedWidgetId: widget_id }
		}),
		render: (output) => ({
			title: "Widget Removed",
			blocks: [
				doc.fields([
					["Dashboard", `${output.dashboard.name} (${output.dashboard.id})`],
					["Removed Widget ID", output.removedWidgetId],
					["Remaining widgets", output.dashboard.widgetCount],
					["Updated", output.dashboard.updatedAt.slice(0, 19)],
				]),
			],
		}),
	})
}
