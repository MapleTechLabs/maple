import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Result, Schema } from "effect"
import { UpdateDashboardWidgetOutput } from "@maple/domain/mcp-outputs"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import {
	type DashboardWidget,
	dashboardNotFound,
	optionalJsonText,
	optionalWidgetJson,
	toDashboardRow,
	toMcpDashboardError,
	withDashboardMutation,
} from "../lib/dashboard-mutations"
import { hasWidgetPatch, patchWidget, type WidgetPatch } from "../lib/dashboard-widget-patch"
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

const PatchObject = Schema.Record(Schema.String, Schema.Unknown)

const widgetNotFound = (widgetId: string) =>
	new McpInvalidInputError({
		message: `Widget not found: ${widgetId}. Use get_dashboard to see existing widget ids.`,
		parameter: "widget_id",
	})

/** The widget to save: `widget_json` as given, or the saved widget with the patch merged in. */
const resolveReplacement = Effect.fn("McpTool.updateDashboardWidget.resolve")(function* (
	dashboardId: string,
	widgetId: string,
	widgetJson: DashboardWidget | undefined,
	patch: WidgetPatch,
) {
	const patching = hasWidgetPatch(patch)
	if (widgetJson !== undefined && patching) {
		return yield* new McpInvalidInputError({
			message:
				"Pass widget_json to replace the whole widget, or patch_json/title/chart_id to edit part of it, not both.",
			parameter: "widget_json",
		})
	}
	if (widgetJson !== undefined) return widgetJson
	if (!patching) {
		return yield* new McpInvalidInputError({
			message:
				"Nothing to change: pass patch_json, title or chart_id for a partial edit, or widget_json to replace the widget.",
			parameter: "patch_json",
		})
	}
	const tenant = yield* CurrentMcpTenant
	const persistence = yield* DashboardPersistenceService
	const list = yield* persistence.list(tenant.orgId).pipe(Effect.mapError(toMcpDashboardError(TOOL)))
	const dashboard = list.dashboards.find((d) => d.id === dashboardId)
	if (dashboard === undefined) return yield* dashboardNotFound(dashboardId)
	const existing = dashboard.widgets.find((w) => w.id === widgetId)
	if (existing === undefined) return yield* widgetNotFound(widgetId)
	const patched = patchWidget(existing, patch)
	if (Result.isFailure(patched)) {
		return yield* new McpInvalidInputError({ message: patched.failure, parameter: "patch_json" })
	}
	return patched.success
})

export function registerUpdateDashboardWidgetTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Update Dashboard Widget",
		description:
			"Edit one widget on a dashboard; other widgets and the dashboard metadata are untouched. " +
			"For small changes pass title, chart_id or patch_json (merged into the saved widget); widget_json replaces the whole widget, so leaving `timeRange` out of it removes an override. Read describe_dashboard_schema before editing. " +
			"The result carries render warnings and a validation verdict; suspicious or broken means the chart will not render meaningfully as saved.",
		parameters: Schema.Struct({
			dashboard_id: P.text("Dashboard ID (ids from list_dashboards)"),
			widget_id: P.text("ID of the widget to edit (get_dashboard lists them)"),
			widget_json: optionalWidgetJson(
				"The whole replacement widget as JSON text, the shape of one entry in get_dashboard's widgets[]: { visualization, dataSource, display, layout, timeRange? }. " +
					"`visualization` is the stored value (chart, stat, ...), with display.chartId choosing bar or area; there is no panel_type here. An `id` inside is ignored in favour of widget_id. " +
					"Omit it to patch instead.",
			),
			patch_json: optionalJsonText(
				PatchObject,
				'A partial widget as JSON text, deep-merged into the saved one (JSON Merge Patch: objects merge, arrays replace, null deletes a key). E.g. {"display":{"unit":"ms"}} or {"dataSource":{"sql":"SELECT ..."}}.',
			),
			title: P.optionalText("New display.title; shorthand for a patch that only renames"),
			chart_id: P.optionalText(
				"New display.chartId (e.g. bar-chart, area-chart, line-chart); shorthand for switching a chart's style",
			),
		}),
		output: UpdateDashboardWidgetOutput,
		hints: { readOnly: false, destructive: true, idempotent: true },
		phrases: ["Updating a widget"],
		handler: Effect.fn("McpTool.updateDashboardWidget")(function* ({
			dashboard_id,
			widget_id,
			widget_json,
			patch_json,
			title,
			chart_id,
		}) {
			const patch: WidgetPatch = {
				...(patch_json === undefined ? undefined : { patch: patch_json }),
				...(title === undefined ? undefined : { title }),
				...(chart_id === undefined ? undefined : { chartId: chart_id }),
			}
			const decodedWidget = yield* resolveReplacement(dashboard_id, widget_id, widget_json, patch)

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
				if (index === -1) return Effect.fail(widgetNotFound(widget_id))
				// A patch was merged onto the widget as read above; a concurrent edit to this
				// same widget in between is overwritten, as a whole-widget replace would be.
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
