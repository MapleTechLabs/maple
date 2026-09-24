import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { DashboardWidgetSchema, WidgetLayoutSchema } from "@maple/domain/http"
import { ReplaceDashboardWidgetsOutput } from "@maple/domain/mcp-outputs"
import {
	defaultSizeForVisualization,
	findNextWidgetPosition,
	generateWidgetId,
	jsonText,
	legacyWidgetDataSourceHint,
	toDashboardRow,
	withDashboardMutation,
	type DashboardWidget,
} from "../lib/dashboard-mutations"
import {
	collectBlockingBuilderWarnings,
	inspectWidgetsAfterMutation,
	validationDoc,
} from "../lib/inspect-widget"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { validateWidgetRenderability } from "../lib/validate-widget-renderability"
import { resolvePanelType } from "../lib/panel-type"
import { withScalarReduction } from "../lib/raw-sql-widget"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "replace_dashboard_widgets"

/** A widget as this tool takes it: `id` and `layout` may be left for the tool to fill in. */
const WidgetInput = Schema.Struct({
	...DashboardWidgetSchema.fields,
	id: Schema.optionalKey(Schema.String),
	layout: Schema.optionalKey(WidgetLayoutSchema),
})

const legacyWidgetsHint = (value: unknown): string | undefined => {
	if (!Array.isArray(value)) return undefined
	for (const [index, widget] of value.entries()) {
		const hint = legacyWidgetDataSourceHint(widget)
		if (hint !== undefined) return `widgets_json[${index}]: ${hint}`
	}
	return undefined
}

const invalid = (message: string, example?: string) =>
	new McpInvalidInputError({
		message,
		parameter: "widgets_json",
		...(example === undefined ? undefined : { example }),
	})

export function registerReplaceDashboardWidgetsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		description:
			"Replace ALL widgets on a dashboard in one atomic, validated write — the safe middle ground between many incremental `add/update_dashboard_widget` calls and the corruption-prone full `dashboard_json` replace. Pass `widgets_json`: a JSON array of widget objects (same shape as `widgets[]` from get_dashboard). Each widget's query is validated BEFORE anything is persisted — if any widget references a filter/groupBy the engine can't honor, NOTHING is saved and the offending clauses are returned. Per-widget conveniences: `id` is auto-generated when omitted, and `layout` is auto-placed on a 12-column grid when omitted (so you can pass just `{ visualization, dataSource, display }`). Dashboard metadata (name, description, tags, time range) is left untouched. Returns an automatic validation summary; fix any `suspicious`/`broken` widgets and call again.",
		parameters: Schema.Struct({
			dashboard_id: P.text(
				"ID of the dashboard whose widgets to replace (use list_dashboards to find IDs)",
			),
			widgets_json: jsonText(
				Schema.Array(WidgetInput),
				'JSON array of widget objects: [{ id?, visualization, dataSource, display, layout?, timeRange? }, ...]. `id` and `layout` are optional (auto-generated/auto-placed). `timeRange` pins one widget to its own window (`{"type":"relative","value":"30m"}` or `{"type":"absolute","startTime":"...","endTime":"..."}`); omit it and the widget follows the dashboard range, which is right for almost every widget. This REPLACES the entire widget list.',
				legacyWidgetsHint,
			),
		}),
		output: ReplaceDashboardWidgetsOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Replacing widgets"],
		handler: Effect.fn("McpTool.replaceDashboardWidgets")(function* ({
			dashboard_id,
			widgets_json: parsed,
		}) {
			if (parsed.length === 0) {
				return yield* invalid(
					"widgets_json must contain at least one widget. To clear individual widgets use remove_dashboard_widget.",
					'[{ "visualization": "stat", "dataSource": { ... }, "display": { ... } }]',
				)
			}

			// Fill in each widget's id and layout. Layouts are auto-placed against the widgets
			// accumulated so far, matching the single-widget add path.
			const widgets: DashboardWidget[] = []
			const repairedScalarIds: string[] = []
			for (const input of parsed) {
				const id = input.id !== undefined && input.id.length > 0 ? input.id : generateWidgetId()
				const layout =
					input.layout ??
					(() => {
						const size = defaultSizeForVisualization(input.visualization)
						return { ...findNextWidgetPosition(widgets, size.w), w: size.w, h: size.h }
					})()
				const decoded: DashboardWidget = { ...input, id, layout }

				// Repair a scalar with no reduction, exactly as the single-widget paths do, so a
				// get_dashboard -> replace_dashboard_widgets round trip over a board holding one
				// legacy stat does not fail outright.
				const panel = resolvePanelType({
					visualization: decoded.visualization,
					chartId: decoded.display.chartId,
				})
				const widget = panel.ok
					? {
							...decoded,
							dataSource: withScalarReduction(decoded.dataSource, panel.resolved.meta.isScalar),
						}
					: decoded
				if (widget.dataSource !== decoded.dataSource) repairedScalarIds.push(widget.id)
				widgets.push(widget)
			}

			const seenIds = new Set<string>()
			for (const w of widgets) {
				if (seenIds.has(w.id)) {
					return yield* invalid(
						`Duplicate widget id "${w.id}" in widgets_json. Each widget needs a unique id (or omit id to auto-generate).`,
					)
				}
				seenIds.add(w.id)
			}

			// Validate every widget's query before persisting anything — an atomic,
			// all-or-nothing guard so a single bad widget can't corrupt the board.
			const blocking = yield* Effect.forEach(widgets, (w) =>
				collectBlockingBuilderWarnings(w.dataSource).pipe(
					Effect.map((warns) => warns.map((warn) => `[${w.id}] ${warn}`)),
				),
			).pipe(Effect.map((nested) => nested.flat()))
			if (blocking.length > 0) {
				return yield* invalid(
					`Some widgets have clauses the engine can't honor — NOTHING was saved:\n- ${blocking.join("\n- ")}\n\nFix and retry. Span/resource attributes work automatically but cap at 5 attr filters; logs/metrics accept only a fixed set of filter/groupBy keys.`,
				)
			}

			// Same all-or-nothing guard for shapes the renderer can't draw: a batch of
			// freshly-authored widgets, not a restore, so fatal issues block here.
			const renderIssues = widgets.map((widget) => ({
				widget,
				issues: validateWidgetRenderability({ widget }),
			}))
			const fatalRenderIssues = renderIssues.flatMap(({ widget, issues }) =>
				issues.fatal.map((message) => `[${widget.id}] ${message}`),
			)
			if (fatalRenderIssues.length > 0) {
				return yield* invalid(
					`Some widgets cannot render as configured — NOTHING was saved:\n- ${fatalRenderIssues.join("\n- ")}`,
				)
			}
			const renderWarnings = renderIssues.flatMap(({ widget, issues }) =>
				issues.warnings.map((message) => `[${widget.id}] ${message}`),
			)

			const dashboard = yield* withDashboardMutation(dashboard_id, TOOL, () => Effect.succeed(widgets))

			const tenant = yield* CurrentMcpTenant
			const validation = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard,
				widgetIds: widgets.map((w) => w.id),
				validate: true,
			})

			const row = toDashboardRow(dashboard)
			return {
				dashboard: { ...row, tags: row.tags ?? [] },
				widgetIds: widgets.map((w) => w.id),
				...(validation.ran ? { validation } : undefined),
				repairedScalarIds,
				renderWarnings,
			}
		}),
		render: (output) => {
			const validation =
				output.validation === undefined
					? { blocks: [], next: [] }
					: validationDoc(output.validation, { single: true, dashboardId: output.dashboard.id })
			return {
				title: "Widgets Replaced",
				blocks: [
					doc.fields([
						["Dashboard", `${output.dashboard.name} (${output.dashboard.id})`],
						["Total widgets", output.dashboard.widgetCount],
						["Updated", output.dashboard.updatedAt.slice(0, 19)],
					]),
					...(output.repairedScalarIds.length > 0
						? [
								doc.text(
									`Note: ${output.repairedScalarIds.length} scalar widget(s) had no \`transform.reduceToValue\` and were given \`{ field: "value", aggregate: "first" }\`. A stat/gauge renders \`[object Object]\` without one: ${output.repairedScalarIds.join(", ")}`,
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
