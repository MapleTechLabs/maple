import { McpInvalidInputError, McpQueryError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { CreateDashboardOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import {
	DashboardTemplateParameterKey,
	PortableDashboardDocument,
	defaultWidgetLayout,
	findNextPosition,
} from "@maple/domain/http"
import { DASHBOARD_TEMPLATES, getTemplate } from "@maple/backend/dashboard-templates"
import { QUERY_BUILDER_DATA_SOURCES, QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import {
	collectBlockingBuilderWarnings,
	inspectWidgetsAfterMutation,
	validationDoc,
} from "../lib/inspect-widget"
import {
	chartDisplayForMetric,
	makeQueryBuilderBreakdownDataSource,
	makeQueryBuilderTimeseriesDataSource,
	makeQueryDraft,
} from "@maple/backend/dashboard-templates/helpers"
import type { TemplateParameterValues, WidgetDef } from "@maple/backend/dashboard-templates"
import { validateDashboardTimeRange } from "../lib/resolve-dashboard-time-range"
import { MAX_LIST_RANGE_SECONDS, MAX_QUERY_RANGE_SECONDS, formatRangeSeconds } from "@maple/query-engine"
import { makeRouteDataSource } from "@maple/widgets/dashboard"
import { collectDocumentRenderWarnings } from "../lib/validate-widget-renderability"
import { toMcpDashboardError, optionalJsonText, toDashboardRow } from "../lib/dashboard-mutations"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "create_dashboard"

const decodePortableDashboard = Schema.decodeUnknownEffect(PortableDashboardDocument)
const decodeParamKey = Schema.decodeUnknownSync(DashboardTemplateParameterKey)

// Simplified widget specs path — MCP-only.

/** The kinds `simpleSpecToWidget` actually knows how to build. */
const SIMPLE_SPEC_VISUALIZATIONS = ["chart", "stat", "table", "list"] as const

/**
 * One simplified widget spec. The closed sets are checked by the schema: an unrecognised
 * `metric_type` used to be silently coerced to `gauge`, which aggregates a counter wrong, and a
 * `pie` here was persisted with a timeseries data source it cannot draw.
 */
const SimpleWidgetSpec = Schema.Struct({
	title: Schema.String,
	visualization: Schema.optionalKey(Schema.Literals(SIMPLE_SPEC_VISUALIZATIONS)),
	source: Schema.Literals(QUERY_BUILDER_DATA_SOURCES),
	metric: Schema.optionalKey(Schema.String),
	metric_name: Schema.optionalKey(Schema.String),
	metric_type: Schema.optionalKey(Schema.Literals(QUERY_BUILDER_METRIC_TYPES)),
	service_name: Schema.optionalKey(Schema.String),
	group_by: Schema.optionalKey(Schema.String),
	unit: Schema.optionalKey(Schema.String),
})
type SimpleWidgetSpec = typeof SimpleWidgetSpec.Type

function inferUnit(metric: string): string {
	if (["avg_duration", "p50_duration", "p95_duration", "p99_duration"].includes(metric))
		return "duration_ms"
	if (metric === "error_rate") return "percent"
	return "number"
}

const VALID_GROUP_BY: Record<string, readonly string[]> = {
	traces: ["service.name", "span.name", "status.code", "http.method", "none"],
	logs: ["service.name", "severity", "none"],
	metrics: ["service.name", "none"],
} satisfies Record<string, readonly string[]>

function validateGroupBy(rawGroupBy: string, source: string, widgetTitle: string): string | null {
	const validOptions = VALID_GROUP_BY[source] ?? []

	if (validOptions.includes(rawGroupBy)) return null
	if (source === "metrics" && rawGroupBy.startsWith("attr.") && rawGroupBy.length > 5) return null

	const optsList = [...validOptions, ...(source === "metrics" ? ["attr.<key>"] : [])]
	return `Widget "${widgetTitle}": invalid group_by "${rawGroupBy}" for source=${source}. Valid: ${optsList.join(", ")}. ${source === "metrics" ? "Example: attr.signal" : ""}`
}

function simpleSpecToWidget(
	spec: SimpleWidgetSpec,
	id: string,
	layout: { x: number; y: number; w: number; h: number },
): WidgetDef | string {
	const viz = spec.visualization ?? "chart"
	const source = spec.source

	const dataSource = source

	if (dataSource === "metrics" && (!spec.metric_name || !spec.metric_type)) {
		return `Widget "${spec.title}": source=metrics requires metric_name and metric_type. Use list_metrics to discover.`
	}
	const metricType = spec.metric_type

	const metric = spec.metric ?? (source === "metrics" ? "avg" : "count")
	const where = spec.service_name ? `service.name = "${spec.service_name}"` : ""

	let groupBy: string[]
	if (spec.group_by) {
		const validationError = validateGroupBy(spec.group_by, source, spec.title)
		if (validationError) return validationError
		groupBy = [spec.group_by]
	} else {
		groupBy = viz === "stat" ? [] : ["service.name"]
	}

	const queryDraft = makeQueryDraft({
		id: `q-${id}`,
		name: spec.title,
		dataSource,
		aggregation: metric,
		whereClause: where,
		groupBy,
		metricName: spec.metric_name,
		...(metricType === undefined ? undefined : { metricType }),
	})

	const unit = spec.unit ?? inferUnit(metric)
	const display: Record<string, unknown> = { title: spec.title, unit } satisfies Record<string, unknown>

	if (viz === "table") {
		if (groupBy.length === 0 || groupBy[0] === "none") {
			return `Widget "${spec.title}": table visualization requires a group_by field (e.g. service.name, span.name).`
		}
		const ds = makeQueryBuilderBreakdownDataSource([queryDraft])
		return {
			id,
			visualization: viz,
			dataSource: ds,
			display: {
				title: spec.title,
				columns: [
					{
						field: "name",
						header:
							groupBy[0]?.replace(".", " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) ??
							"Name",
					},
					{ field: "value", header: spec.title, unit, align: "right" },
				],
			},
			layout,
		}
	}

	if (viz === "list") {
		if (source === "logs") {
			return {
				id,
				visualization: viz,
				dataSource: makeRouteDataSource("list_logs", {
					...(spec.service_name ? { service: spec.service_name } : undefined),
					limit: 10,
				}),
				display: { title: spec.title, listDataSource: "logs", listLimit: 10 },
				layout,
			}
		}
		return {
			id,
			visualization: viz,
			dataSource: makeRouteDataSource("list_traces", {
				...(spec.service_name ? { service: spec.service_name } : undefined),
				limit: 10,
			}),
			display: { title: spec.title, listDataSource: "traces", listLimit: 10 },
			layout,
		}
	}

	if (viz === "stat") {
		// Same endpoint and query draft as every other kind here. This used to
		// build the legacy `custom_timeseries` shape with its own filter bag and a
		// `flattenSeries` step, so an agent-made stat was the one widget on a
		// dashboard that did not go through the query builder — and so the only one
		// `collectBlockingBuilderWarnings` could never inspect.
		//
		// A timeseries query source returns wide rows (`{ bucket, <series>:
		// value }`), which `reduceToValue` reads directly — no flattening. Naming
		// the series after the widget title is a best effort; `resolveField` falls
		// back to the first numeric column, which for a single-query stat is the
		// only series.
		return {
			id,
			visualization: viz,
			dataSource: {
				...makeQueryBuilderTimeseriesDataSource([queryDraft]),
				transform: { reduceToValue: { field: spec.title, aggregate: "avg" } },
			},
			display,
			layout,
		}
	}

	const ds = makeQueryBuilderTimeseriesDataSource([queryDraft])
	Object.assign(display, chartDisplayForMetric(metric))

	return {
		id,
		visualization: viz,
		dataSource: ds,
		display,
		layout,
	}
}

/**
 * Grid rectangles for a run of simplified specs.
 *
 * Placement is the shared `findNextPosition`, so this agrees with the web store,
 * the MCP widget tools and the Perses importer instead of being a fourth
 * algorithm. What stays local is the *width* policy, which is genuinely this
 * tool's own: stats are quarter-width so a row of them reads as a strip of KPIs,
 * everything else is full-bleed because a simplified spec carries no layout
 * intent to honour.
 */
function computeAutoLayout(
	specs: ReadonlyArray<SimpleWidgetSpec>,
): Array<{ x: number; y: number; w: number; h: number }> {
	const placed: Array<{ layout: { x: number; y: number; w: number; h: number } }> = []

	for (const spec of specs) {
		const viz = spec.visualization ?? "chart"
		const { h } = defaultWidgetLayout(viz)
		const w = viz === "stat" ? 4 : 12
		placed.push({ layout: { ...findNextPosition(placed, w), w, h } })
	}

	return placed.map((widget) => widget.layout)
}

function buildSimpleWidgets(specs: ReadonlyArray<SimpleWidgetSpec>): WidgetDef[] | string {
	const layouts = computeAutoLayout(specs)
	const widgets: WidgetDef[] = []
	const errors: string[] = []

	for (let i = 0; i < specs.length; i++) {
		const result = simpleSpecToWidget(specs[i]!, `w${i}`, layouts[i]!)
		if (typeof result === "string") {
			errors.push(result)
		} else {
			widgets.push(result)
		}
	}

	return errors.length > 0 ? errors.join("\n") : widgets
}
const DEFAULT_TIME_RANGE = "1h"

const TEMPLATE_IDS = [...DASHBOARD_TEMPLATES.map((t) => t.id), "custom"]

const invalid = (message: string, parameter?: string, example?: string) =>
	new McpInvalidInputError({
		message,
		...(parameter === undefined ? undefined : { parameter }),
		...(example === undefined ? undefined : { example }),
	})

const SIMPLE_WIDGETS_EXAMPLE =
	'widgets=\'[{"title":"HTTP Duration","visualization":"chart","source":"metrics","metric":"avg","metric_name":"http.server.duration","metric_type":"histogram"}]\''

// Tool registration

export function registerCreateDashboardTool(server: McpToolRegistrar) {
	const templateList = DASHBOARD_TEMPLATES.map((t) => `  ${t.id} — ${t.description}`).join("\n")

	server.define({
		name: TOOL,
		// Kept deliberately short: this is routing information — which of the three
		// modes to use — not a schema reference. The per-parameter descriptions carry
		// the shapes, and `describe_dashboard_schema` carries the full vocabulary.
		description:
			"Create a dashboard one of three ways: from a `template`, from simplified `widgets` specs, or from full `dashboard_json`.\n\n" +
			"Templates:\n" +
			templateList +
			"\n\nCreated widgets are inspected (up to 12) and returned with a per-widget verdict " +
			"(looks_healthy/suspicious/broken). Use `inspect_chart_data` for any beyond that cap, " +
			"or pass `validate: false` to skip inspection entirely.",
		parameters: Schema.Struct({
			name: P.text("Dashboard name"),
			template: P.optionalOneOf(
				TEMPLATE_IDS,
				"Template ID. Default: service-health (if no widgets/dashboard_json). `custom` requires `dashboard_json`.",
			),
			service: P.service("Scope template widgets to a specific service"),
			time_range: P.optionalText(
				`Dashboard time range as relative shorthand — e.g. 15m, 6h, 24h, 7d, 2w, 3mo, or "today". Up to ${formatRangeSeconds(MAX_QUERY_RANGE_SECONDS)} (default: ${DEFAULT_TIME_RANGE}). Note that list widgets (recent traces/logs) only support ${formatRangeSeconds(MAX_LIST_RANGE_SECONDS)} and will ask the viewer to narrow their range on wider dashboards.`,
			),
			description: P.optionalText("Dashboard description"),
			metric_name: P.optionalText(
				"Metric name for metric-overview template (use list_metrics to discover). Example: http.server.duration",
			),
			metric_type: P.optionalOneOf(
				QUERY_BUILDER_METRIC_TYPES,
				"Metric type for metric-overview template",
			),
			widgets: P.optionalJson(
				Schema.Array(SimpleWidgetSpec),
				'JSON array of simplified widget specs (same params as query_data). Each: { title, visualization?: "chart"|"stat"|"table"|"list", source: "traces"|"logs"|"metrics"|"product_events", metric?, metric_name?, metric_type?, service_name?, group_by?, unit? }. ' +
					"group_by: traces=service.name|span.name|status.code|http.method|none; logs=service.name|severity|none; metrics=service.name|attr.<key>|none. " +
					'"table" requires group_by; "list" shows recent traces or logs.',
			),
			dashboard_json: optionalJsonText(
				PortableDashboardDocument,
				"Full dashboard JSON for complete control over widget configuration. Call `describe_dashboard_schema` first for the panel types, the four kind-discriminated data-source shapes, the unit vocabulary and the aggregation/group-by tokens — all generated from the live schema.",
			),
			validate: P.optionalFlag(
				"Set to false to skip automatic data validation on the created widgets. Default: validate.",
			),
		}),
		aliases: P.SERVICE_ALIASES,
		output: CreateDashboardOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Creating a dashboard"],
		handler: Effect.fn("McpTool.createDashboard")(function* (params) {
			if (params.time_range) {
				const timeRangeError = validateDashboardTimeRange(params.time_range)
				if (timeRangeError) return yield* invalid(timeRangeError, "time_range")
			}

			const templateName =
				params.template ??
				(params.widgets ? undefined : params.dashboard_json ? "custom" : "service-health")

			let portable: PortableDashboardDocument
			let source: typeof CreateDashboardOutput.Type.source

			if (templateName === "custom") {
				if (!params.dashboard_json) {
					return yield* invalid(
						"Provide dashboard_json for custom template, or use a different approach:\n\n" +
							"Simplified widgets example:\n" +
							`  ${SIMPLE_WIDGETS_EXAMPLE}\n\n` +
							`Templates: ${DASHBOARD_TEMPLATES.map((t) => t.id).join(", ")}\n\n` +
							"For full custom JSON, use get_dashboard on an existing dashboard to see the expected schema.",
						"dashboard_json",
					)
				}
				portable = params.dashboard_json
				source = "dashboard_json"
			} else if (!templateName && params.widgets) {
				if (params.widgets.length === 0) {
					return yield* invalid(
						"widgets must be a non-empty JSON array.",
						"widgets",
						SIMPLE_WIDGETS_EXAMPLE,
					)
				}
				const result = buildSimpleWidgets(params.widgets)
				if (typeof result === "string") return yield* invalid(result, "widgets")

				// The same pre-persist gate the widget mutation tools run. A simplified spec
				// that silently dropped a clause (an unsupported group-by, an over-cap filter
				// set) was otherwise persisted and surfaced only as a confidently wrong chart.
				const blocking = yield* Effect.forEach(result, (widget) =>
					collectBlockingBuilderWarnings(widget.dataSource).pipe(
						Effect.map((warnings) =>
							warnings.map((w) => `${widget.display.title ?? widget.id}: ${w}`),
						),
					),
				).pipe(Effect.map((all) => all.flat()))

				if (blocking.length > 0) {
					return yield* invalid(
						`These widgets would not query what they describe:\n${blocking.map((w) => `  - ${w}`).join("\n")}`,
						"widgets",
					)
				}

				portable = yield* decodePortableDashboard({
					name: params.name,
					...(params.description ? { description: params.description } : undefined),
					timeRange: { type: "relative", value: params.time_range ?? DEFAULT_TIME_RANGE },
					widgets: result,
				}).pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: `Widget generation error: ${String(error)}`,
								pipeName: TOOL,
								cause: error,
							}),
					),
				)
				source = "widgets"
			} else if (templateName) {
				const template = getTemplate(templateName)
				if (!template) {
					return yield* invalid(
						`Unknown template "${templateName}". Available: ${DASHBOARD_TEMPLATES.map((t) => t.id).join(", ")}, custom`,
						"template",
					)
				}

				const templateParams: TemplateParameterValues = {}
				if (params.service) templateParams[decodeParamKey("service_name")] = params.service
				if (params.metric_name) templateParams[decodeParamKey("metric_name")] = params.metric_name
				if (params.metric_type) templateParams[decodeParamKey("metric_type")] = params.metric_type

				const missingRequired = template.parameters
					.filter((p) => p.required && !templateParams[p.key])
					.map((p) => (p.key === "service_name" ? "service" : p.key))
				if (missingRequired.length > 0) {
					return yield* invalid(
						`Template "${template.id}" requires parameters: ${missingRequired.join(", ")}. Pass them as tool args (e.g. metric_name, metric_type).`,
						missingRequired[0],
					)
				}

				portable = yield* Effect.try({
					try: () => {
						const built = template.build(templateParams)
						const description = params.description ?? built.description
						return new PortableDashboardDocument({
							name: params.name || built.name,
							...(description ? { description } : undefined),
							...(built.tags ? { tags: built.tags } : undefined),
							// An explicit time_range wins over the template's default.
							timeRange: params.time_range
								? { type: "relative" as const, value: params.time_range }
								: built.timeRange,
							widgets: built.widgets,
						})
					},
					catch: (error) =>
						new McpQueryError({
							message: `Template generation error: ${String(error)}`,
							pipeName: TOOL,
							cause: error,
						}),
				})
				source = "template"
			} else {
				return yield* invalid(
					"Provide a template, widgets, or dashboard_json.\n\n" +
						`Templates: ${DASHBOARD_TEMPLATES.map((t) => t.id).join(", ")}\n` +
						'Simplified widgets: widgets=\'[{"title":"...","source":"metrics","metric_name":"...","metric_type":"..."}]\'\n' +
						"Custom JSON: dashboard_json with full widget definitions",
				)
			}

			const tenant = yield* CurrentMcpTenant
			const persistence = yield* DashboardPersistenceService

			const dashboard = yield* persistence
				.create(tenant.orgId, tenant.userId, portable)
				.pipe(Effect.mapError(toMcpDashboardError(TOOL)))

			const validation = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard,
				widgetIds: dashboard.widgets.map((w) => w.id),
				validate: params.validate !== false,
			})

			return {
				dashboard: toDashboardRow(dashboard),
				...(validation.ran ? { validation } : undefined),
				source,
				...(source === "template" && templateName ? { template: templateName } : undefined),
				// Advisory across every creation path, including `dashboard_json`.
				renderWarnings: collectDocumentRenderWarnings(dashboard.widgets),
			}
		}),
		render: (output) => {
			const validation =
				output.validation === undefined
					? { blocks: [], next: [] }
					: validationDoc(output.validation, { single: false, dashboardId: output.dashboard.id })
			return {
				title: "Dashboard Created",
				blocks: [
					doc.fields([
						["ID", output.dashboard.id],
						["Name", output.dashboard.name],
						["Description", output.dashboard.description],
						["Widgets", output.dashboard.widgetCount],
						["Created", output.dashboard.createdAt.slice(0, 19)],
						["Template", output.template],
						["Source", output.source === "widgets" ? "simplified widget specs" : undefined],
					]),
					...(output.renderWarnings.length > 0
						? [doc.heading("Render warnings (saved anyway)"), doc.list(output.renderWarnings)]
						: []),
					...validation.blocks,
				],
				next: [
					...validation.next,
					...(output.validation?.capped === true
						? [
								doc.next(
									"get_dashboard",
									{ dashboard_id: output.dashboard.id },
									"list the widget ids to inspect beyond the cap",
								),
							]
						: []),
				],
			}
		},
	})
}
