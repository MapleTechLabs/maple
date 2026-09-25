import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { UpdateDashboardWidgetOutput } from "@maple/domain/mcp-outputs"
import { toDashboardRow, widgetJson, withDashboardMutation } from "../lib/dashboard-mutations"
import { formatRenderIssues, validateWidgetRenderability } from "../lib/validate-widget-renderability"
import { resolvePanelType } from "../lib/panel-type"
import { withScalarReduction } from "../lib/raw-sql-widget"
import {
	collectBlockingBuilderWarnings,
	inspectWidgetsAfterMutation,
	validationDoc,
} from "../lib/inspect-widget"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "update_dashboard_widget"

export function registerUpdateDashboardWidgetTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		description:
			"Replace one widget on a dashboard with the full widget object; other widgets and the dashboard metadata are untouched. Read describe_dashboard_schema before editing. " +
			"Whole-widget semantics: leave `timeRange` out and an existing per-widget override is removed. " +
			"The result carries render warnings and a validation verdict; suspicious or broken means the chart will not render meaningfully as saved.",
		parameters: Schema.Struct({
			dashboard_id: P.text("Dashboard ID (ids from list_dashboards)"),
			widget_id: P.text("ID of the widget to replace (get_dashboard lists them)"),
			widget_json: widgetJson(
				"The replacement widget as JSON text, the shape of one entry in get_dashboard's widgets[]: { visualization, dataSource, display, layout, timeRange? }. " +
					"`visualization` is the stored value (chart, stat, ...), with display.chartId choosing bar or area; there is no panel_type here. An `id` inside is ignored in favour of widget_id.",
			),
		}),
		output: UpdateDashboardWidgetOutput,
		hints: { readOnly: false, destructive: true, idempotent: true },
		phrases: ["Updating a widget"],
		handler: Effect.fn("McpTool.updateDashboardWidget")(function* ({
			dashboard_id,
			widget_id,
			widget_json: decodedWidget,
		}) {
			// Repair rather than reject. A scalar tile needs `transform.reduceToValue`
			// to read `data[0].value`, and plenty of stored stats predate that being
			// checked — blocking here would make a legacy widget uneditable, so you
			// could not even fix its title. `add_dashboard_widget` injects the same
			// default, so both paths agree.
			const panel = resolvePanelType({
				visualization: decodedWidget.visualization,
				chartId: decodedWidget.display.chartId,
			})
			const parsedWidget = panel.ok
				? {
						...decodedWidget,
						dataSource: withScalarReduction(
							decodedWidget.dataSource,
							panel.resolved.meta.isScalar,
						),
					}
				: decodedWidget
			const repairedScalar = parsedWidget.dataSource !== decodedWidget.dataSource

			// Reject clauses the engine can't honor before persisting the replacement.
			const blockingWarnings = yield* collectBlockingBuilderWarnings(parsedWidget.dataSource)
			if (blockingWarnings.length > 0) {
				return yield* new McpInvalidInputError({
					message: `This widget's query has clauses the engine can't honor, which would silently change what the chart shows (the widget was NOT updated):\n- ${blockingWarnings.join("\n- ")}\n\nFix and retry. Notes: span/resource attributes work automatically (e.g. \`query.context = "x"\`) but cap at 5 attr filters; logs/metrics accept only a fixed set of filter/groupBy keys; prefix non-allowlisted groupBy keys with \`attr.\`.`,
					parameter: "widget_json",
				})
			}

			// Combinations the renderer cannot draw — a scalar with no reduction, a
			// note wired to a query, a list backed by SQL.
			const renderIssues = validateWidgetRenderability({ widget: parsedWidget })
			if (renderIssues.fatal.length > 0) {
				return yield* new McpInvalidInputError({
					message: `This widget cannot render as configured (it was NOT updated):\n${formatRenderIssues({ fatal: renderIssues.fatal, warnings: [] })}`,
					parameter: "widget_json",
				})
			}

			const dashboard = yield* withDashboardMutation(dashboard_id, TOOL, (existingWidgets) => {
				const index = existingWidgets.findIndex((w) => w.id === widget_id)
				if (index === -1) {
					return Effect.fail(
						new McpInvalidInputError({
							message: `Widget not found: ${widget_id}. Use get_dashboard to see existing widget ids.`,
							parameter: "widget_id",
						}),
					)
				}
				const next = existingWidgets.slice()
				next[index] = { ...parsedWidget, id: widget_id }
				return Effect.succeed(next)
			})

			const updated = dashboard.widgets.find((w) => w.id === widget_id)

			const tenant = yield* CurrentMcpTenant
			const validation = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard,
				widgetIds: [widget_id],
				validate: true,
			})

			return {
				dashboard: toDashboardRow(dashboard),
				widgetId: widget_id,
				...(validation.ran ? { validation } : undefined),
				visualization: updated?.visualization ?? parsedWidget.visualization,
				repairedScalar,
				renderWarnings: [...renderIssues.warnings],
			}
		}),
		render: (output) => {
			const validation =
				output.validation === undefined
					? { blocks: [], next: [] }
					: validationDoc(output.validation, { single: true, dashboardId: output.dashboard.id })
			return {
				title: "Widget Updated",
				blocks: [
					doc.fields([
						["Dashboard", `${output.dashboard.name} (${output.dashboard.id})`],
						["Widget ID", output.widgetId],
						["Visualization", output.visualization],
						["Total widgets", output.dashboard.widgetCount],
						["Updated", output.dashboard.updatedAt.slice(0, 19)],
					]),
					...(output.repairedScalar
						? [
								doc.text(
									'Note: this widget had no `transform.reduceToValue`, so `{ field: "value", aggregate: "first" }` was added. A stat/gauge renders `[object Object]` without one. Set it explicitly to choose a different reducer.',
								),
							]
						: []),
					...(output.renderWarnings.length > 0
						? [doc.heading("Render warnings"), doc.list(output.renderWarnings)]
						: []),
					...validation.blocks,
				],
				next: validation.next,
			}
		},
	})
}
