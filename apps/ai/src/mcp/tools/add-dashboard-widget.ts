import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import {
	MCP_PANEL_TYPES,
	MCP_VISUALIZATIONS,
	RawSqlDisplayType,
	TimeRangeSchema,
	WidgetDisplayConfigSchema,
	WidgetLayoutSchema,
} from "@maple/domain/http"
import { AddDashboardWidgetOutput } from "@maple/domain/mcp-outputs"
import {
	defaultSizeForPanelType,
	findNextWidgetPosition,
	generateWidgetId,
	optionalDataSourceJson,
	optionalJsonText,
	toDashboardRow,
	withDashboardMutation,
	type DashboardWidget,
} from "../lib/dashboard-mutations"
import { buildRawSqlDataSource, validateRawSql, withScalarReduction } from "../lib/raw-sql-widget"
import { makeProductEventsFunnelDataSource, makeProductEventsPathsDataSource } from "@maple/widgets/dashboard"
import { resolvePanelType } from "../lib/panel-type"
import { formatRenderIssues, validateWidgetRenderability } from "../lib/validate-widget-renderability"
import {
	collectBlockingBuilderWarnings,
	inspectWidgetsAfterMutation,
	validationDoc,
} from "../lib/inspect-widget"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "add_dashboard_widget"

const invalid = (message: string, example?: string, parameter?: string) =>
	new McpInvalidInputError({
		message,
		...(example === undefined ? undefined : { example }),
		...(parameter === undefined ? undefined : { parameter }),
	})

export function registerAddDashboardWidgetTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		// The panel-type list is the `panel_type` enum, where it is binding; do not repeat it here.
		description:
			"Add a single widget to an existing dashboard without re-sending the whole document. Two creation paths:\n\n" +
			"1. **Structured query builder**: pass `data_source_json` (a `kind`-discriminated data source) plus `display_json`.\n" +
			"2. **Raw ClickHouse SQL**: pass `sql` instead and the tool builds the data source. `sql` MUST reference `$__orgFilter`. Call `describe_warehouse_tables` first so you do not guess table or column names.\n\n" +
			"**Call `describe_dashboard_schema` before authoring** for the data-source kinds, unit vocabulary (`percent` is a 0–1 fraction, `percent_100` is 0–100 — inverted from Grafana), aggregations and group-by tokens, all generated from the live schema.\n\n" +
			"Layout is auto-placed when `layout_json` is omitted. The response carries an automatic validation summary; a `suspicious` or `broken` verdict means the chart will not render meaningfully as-is.",
		parameters: Schema.Struct({
			dashboard_id: P.text(
				"ID of the dashboard to add the widget to (use list_dashboards to find IDs)",
			),
			// The enum is the list: a newly `mcpExposed` widget type is advertised and accepted
			// from the same table.
			panel_type: P.optionalOneOf(
				MCP_PANEL_TYPES,
				"The widget KIND — not a title (set that via `display_json.title`). This one field replaces the old `visualization` + `display_json.chartId` + `display_type` combination: `bar` and `area` are directly reachable here, and the matching `chartId` and raw-SQL display type are derived for you.",
			),
			visualization: P.optionalOneOf(
				MCP_VISUALIZATIONS,
				"Legacy alias for `panel_type`, still accepted. It collapses line/bar/area into `chart` and then needs `display_json.chartId` to tell them apart — prefer `panel_type`.",
			),
			sql: P.optionalText(
				'Raw ClickHouse SQL with macros (`$__orgFilter` required). When set, the tool builds a `kind: "raw_sql"` data source and ignores `data_source_json`.',
			),
			display_type: P.optionalOneOf(
				RawSqlDisplayType.literals,
				"Raw SQL display type. Only used when `sql` is set. Derived from `panel_type` (or `visualization` + `display_json.chartId`) if omitted.",
			),
			granularity_seconds: P.optionalNumber(
				"Bucket size in seconds for raw SQL timeseries. Only used when `sql` is set. If omitted the server auto-computes from the dashboard time range.",
			),
			data_source_json: optionalDataSourceJson(
				"JSON string for the widget's `kind`-discriminated data source (see `describe_dashboard_schema` section `data_sources`). Required for the structured-query path; ignored when `sql` is set, and derived for you when `display_json.funnel.steps` defines a product-event funnel. Use get_dashboard on an existing widget to see the exact shape.",
			),
			display_json: optionalJsonText(
				WidgetDisplayConfigSchema,
				"JSON string for the widget's display config: { title?, unit?, thresholds?, chartId?, columns?, ... }. Required for the structured-query path; defaults to `{}` for the raw-SQL path. Use get_dashboard on an existing widget to see the exact shape.",
			),
			layout_json: optionalJsonText(
				WidgetLayoutSchema,
				"Optional layout { x, y, w, h }. If omitted the widget is auto-placed using a 12-column grid with sensible default sizes per visualization.",
			),
			widget_id: P.optionalText(
				"Optional stable id for the new widget. If omitted a UUID is generated.",
			),
			time_range_json: P.optionalJson(
				TimeRangeSchema,
				'Optional time range pinning this widget to its own window instead of the dashboard\'s: `{"type":"relative","value":"30m"}` or `{"type":"absolute","startTime":"...","endTime":"..."}` (ISO 8601). Omit it and the widget follows the dashboard range, which is what almost every widget should do — use it only when the tile genuinely means a different window (an "active in the last 30 minutes" stat on a 7-day board). The widget header labels the override so readers can see it.',
			),
		}),
		output: AddDashboardWidgetOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Adding a widget"],
		handler: Effect.fn("McpTool.addDashboardWidget")(function* ({
			dashboard_id,
			panel_type,
			visualization,
			sql,
			display_type,
			granularity_seconds,
			data_source_json,
			display_json,
			layout_json,
			widget_id,
			time_range_json,
		}) {
			const useRawSql = sql !== undefined

			const decodedDisplay: DashboardWidget["display"] = display_json ?? {}

			// A product-event funnel is defined by `display_json.funnel.steps` alone:
			// its data source is derived from that definition, so a caller need not
			// (and should not) hand-assemble the route.
			const funnelSteps = decodedDisplay.funnel?.steps
			const funnelDefinition =
				funnelSteps !== undefined && funnelSteps.length > 0
					? {
							steps: funnelSteps,
							keyBy: decodedDisplay.funnel?.keyBy,
							windowSeconds: decodedDisplay.funnel?.windowSeconds,
							breakdownBy: decodedDisplay.funnel?.breakdownBy,
							filters: decodedDisplay.funnel?.filters,
							variant: decodedDisplay.funnel?.variant,
						}
					: undefined
			// Likewise a paths widget: `display_json.paths` is the whole definition.
			const pathsDefinition = decodedDisplay.paths

			if (
				!useRawSql &&
				funnelDefinition === undefined &&
				pathsDefinition === undefined &&
				(!data_source_json || !display_json)
			) {
				return yield* invalid(
					"add_dashboard_widget requires either `sql` (raw ClickHouse SQL path), both `data_source_json` and `display_json` (structured-query path), a `display_json.funnel.steps` definition (product-event funnel), or a `display_json.paths` definition (paths).",
					'{ "sql": "SELECT count() FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)" }',
				)
			}

			// One decision, one field. `panel_type` is preferred; `visualization`
			// stays accepted so agents and transcripts written against the old
			// surface keep working.
			const panelResolution = resolvePanelType({
				panel_type,
				visualization,
				chartId: decodedDisplay.chartId,
			})
			if (!panelResolution.ok) {
				return yield* invalid(panelResolution.error, panelResolution.example, "panel_type")
			}
			const panel = panelResolution.resolved

			let dataSource: DashboardWidget["dataSource"]
			if (useRawSql) {
				// `list` has no raw-SQL rendering, so `rawSqlDisplayTypeFor` used to
				// fall back to `"line"` and the widget silently became a line chart.
				if (panel.rawSqlDisplayType === undefined) {
					return yield* invalid(
						`\`panel_type: "${panel.panelType}"\` has no raw-SQL rendering, so passing \`sql\` would silently render it as a line chart. For tabular SQL results use \`panel_type: "table"\`; a list is configured via \`display_json.listDataSource\` instead.`,
						'{ "panel_type": "table", "sql": "SELECT ..." }',
					)
				}
				const sqlError = validateRawSql(sql)
				if (sqlError) {
					return yield* invalid(
						sqlError,
						"SELECT count() FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					)
				}
				const displayType = display_type ?? panel.rawSqlDisplayType
				dataSource = buildRawSqlDataSource({
					visualization: panel.visualization,
					sql,
					displayType,
					granularitySeconds: granularity_seconds,
				})
			} else if (funnelDefinition !== undefined && !data_source_json) {
				if (panel.visualization !== "funnel") {
					return yield* invalid(
						`\`display_json.funnel.steps\` defines a product-event funnel, which only \`panel_type: "funnel"\` renders (got \`${panel.panelType}\`).`,
						'{ "panel_type": "funnel", "display_json": "{\\"title\\":\\"Signup funnel\\",\\"funnel\\":{\\"steps\\":[{\\"kind\\":\\"page\\",\\"pagePath\\":\\"/pricing\\"},{\\"kind\\":\\"event\\",\\"eventName\\":\\"signup_completed\\"}]}}" }',
					)
				}
				dataSource = makeProductEventsFunnelDataSource(funnelDefinition)
			} else if (pathsDefinition !== undefined || panel.visualization === "paths") {
				// A paths panel has exactly one source, derived from its definition.
				// A caller-supplied one would feed the chart rows it cannot read.
				if (data_source_json) {
					return yield* invalid(
						'`panel_type: "paths"` derives its data source from `display_json.paths`; do not pass `data_source_json`.',
						'{ "panel_type": "paths", "display_json": "{\\"title\\":\\"After signup\\",\\"paths\\":{\\"anchor\\":{\\"kind\\":\\"event\\",\\"eventName\\":\\"signup_completed\\"}}}" }',
					)
				}
				if (pathsDefinition === undefined) {
					return yield* invalid(
						'`panel_type: "paths"` needs `display_json.paths` with an `anchor` (`{ "kind": "event", "eventName": … }` or `{ "kind": "page", "pagePath": … }`).',
						'{ "panel_type": "paths", "display_json": "{\\"title\\":\\"After signup\\",\\"paths\\":{\\"anchor\\":{\\"kind\\":\\"event\\",\\"eventName\\":\\"signup_completed\\"}}}" }',
					)
				}
				if (panel.visualization !== "paths") {
					return yield* invalid(
						`\`display_json.paths\` defines a paths widget, which only \`panel_type: "paths"\` renders (got \`${panel.panelType}\`).`,
						'{ "panel_type": "paths", "display_json": "{\\"title\\":\\"After signup\\",\\"paths\\":{\\"anchor\\":{\\"kind\\":\\"event\\",\\"eventName\\":\\"signup_completed\\"},\\"depth\\":3}}" }',
					)
				}
				dataSource = makeProductEventsPathsDataSource(pathsDefinition)
			} else {
				if (data_source_json === undefined) {
					return yield* invalid(
						"The structured-query path needs `data_source_json`.",
						'{ "panel_type": "line", "data_source_json": "{\\"kind\\":\\"query\\", …}", "display_json": "{}" }',
						"data_source_json",
					)
				}
				dataSource = data_source_json
				// A scalar tile reads `data[0].value`, so without a reduction it
				// renders `[object Object]`. The raw-SQL path has always injected
				// this; the structured path never did, which made every
				// MCP-authored stat and gauge broken by default.
				dataSource = withScalarReduction(dataSource, panel.meta.isScalar)
			}

			// The canonical `chartId` for the panel type, unless the caller pinned
			// one. This is what makes `panel_type: "bar"` reachable at all on the
			// structured path — previously the only way was a hand-written
			// `display_json.chartId` that no documentation mentioned.
			const display: DashboardWidget["display"] =
				panel.chartId !== undefined && decodedDisplay.chartId === undefined
					? { ...decodedDisplay, chartId: panel.chartId }
					: decodedDisplay

			const renderIssues = validateWidgetRenderability({
				widget: { visualization: panel.visualization, dataSource, display },
				panelType: panel.panelType,
			})
			if (renderIssues.fatal.length > 0) {
				return yield* invalid(
					`This widget cannot render as configured (it was NOT saved):\n${formatRenderIssues({ fatal: renderIssues.fatal, warnings: [] })}`,
				)
			}

			// Reject clauses the query engine can't honor BEFORE persisting, so a
			// mis-scoped widget (dropped filter / group-by) can never be saved
			// silently. Raw-SQL widgets short-circuit (no query-builder warnings).
			const blockingWarnings = yield* collectBlockingBuilderWarnings(dataSource)
			if (blockingWarnings.length > 0) {
				return yield* invalid(
					`This widget's query has clauses the engine can't honor, which would silently change what the chart shows (the widget was NOT saved):\n- ${blockingWarnings.join("\n- ")}\n\nFix and retry. Notes: span/resource attributes work automatically (e.g. \`query.context = "x"\`) but cap at 5 attr filters; logs/metrics accept only a fixed set of filter/groupBy keys; prefix non-allowlisted groupBy keys with \`attr.\`.`,
				)
			}

			const explicitLayout = layout_json
			const timeRange = time_range_json

			const newId = widget_id ?? generateWidgetId()

			const dashboard = yield* withDashboardMutation(dashboard_id, TOOL, (existingWidgets) =>
				Effect.gen(function* () {
					if (existingWidgets.some((w) => w.id === newId)) {
						return yield* invalid(
							`Widget id "${newId}" already exists on dashboard ${dashboard_id}. Pass a different widget_id or omit it to auto-generate one.`,
							undefined,
							"widget_id",
						)
					}

					const layout =
						explicitLayout ??
						(() => {
							// Keyed off the panel type, not the visualization: a gauge
							// carries an `mcpWidth` override that `"chart"` would lose.
							const size = defaultSizeForPanelType(panel.panelType)
							const position = findNextWidgetPosition(existingWidgets, size.w)
							return { ...position, w: size.w, h: size.h }
						})()

					const widget: DashboardWidget = {
						id: newId,
						visualization: panel.visualization,
						dataSource,
						display,
						layout,
						// Absent unless asked for: the key must not exist at all, so the
						// widget reads as "follows the dashboard range".
						...(timeRange ? { timeRange } : undefined),
					}

					return [...existingWidgets, widget]
				}),
			)

			const added = dashboard.widgets.find((w) => w.id === newId)

			const tenant = yield* CurrentMcpTenant
			const validation = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard,
				widgetIds: [newId],
				validate: true,
			})

			return {
				dashboard: toDashboardRow(dashboard),
				widgetId: newId,
				...(validation.ran ? { validation } : undefined),
				panelType: panel.panelType,
				visualization: panel.visualization,
				...(added === undefined
					? undefined
					: {
							layout: {
								x: added.layout.x,
								y: added.layout.y,
								w: added.layout.w,
								h: added.layout.h,
							},
						}),
				...(timeRange ? { widgetTimeRange: timeRange } : undefined),
				renderWarnings: [...renderIssues.warnings],
			}
		}),
		render: (output) => {
			const validation =
				output.validation === undefined
					? { blocks: [], next: [] }
					: validationDoc(output.validation, { single: true, dashboardId: output.dashboard.id })
			const pinned = output.widgetTimeRange
			return {
				title: "Widget Added",
				blocks: [
					doc.fields([
						["Dashboard", `${output.dashboard.name} (${output.dashboard.id})`],
						["Widget ID", output.widgetId],
						["Panel type", `${output.panelType} (visualization: ${output.visualization})`],
						[
							"Time range",
							pinned === undefined
								? undefined
								: `pinned to ${pinned.type === "relative" ? `last ${pinned.value}` : `${pinned.startTime} to ${pinned.endTime}`} (not the dashboard's)`,
						],
						[
							"Layout",
							output.layout === undefined
								? undefined
								: `x=${output.layout.x} y=${output.layout.y} w=${output.layout.w} h=${output.layout.h}`,
						],
						["Total widgets", output.dashboard.widgetCount],
					]),
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
