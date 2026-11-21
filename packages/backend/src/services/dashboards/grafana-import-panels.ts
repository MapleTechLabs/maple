// One Grafana panel to one Maple widget. Pure.
import { type RawSqlDisplayType, type WidgetVisualization, widgetTypeByGrafanaType } from "@maple/domain/http"
import { makePromqlDataSource } from "@maple/widgets/dashboard"
import { Array as Arr, String as Str } from "effect"
import {
	type DashboardWidget,
	type UnknownRecord,
	asArray,
	asRecord,
	asString,
	markdownWidget,
	normalizeClickHouseSql,
	placeholderWidget,
	rawSqlDataSource,
	scalarTransform,
	uniqueWidgetId,
} from "./dashboard-import-shared"
import { chartStyle, type GrafanaTarget, grafanaDisplay } from "./grafana-import-display"
import {
	datasourceType,
	type GrafanaVariableConversion,
	rewriteVariableRefs,
	noteOnce,
	promqlPluginNote,
	speaksPromql,
} from "./grafana-import-variables"

export interface PanelContext {
	readonly variables: GrafanaVariableConversion
	readonly widgetIds: Set<string>
	readonly warnings: string[]
}

export interface ConvertedPanel {
	readonly widget: DashboardWidget
	readonly placeholder: boolean
}

const CLICKHOUSE_TYPES = new Set(["grafana-clickhouse-datasource", "vertamedia-clickhouse-datasource"])

const DATASOURCE_NAMES: ReadonlyMap<string, string> = new Map([
	["loki", "Loki"],
	["tempo", "Tempo"],
	["elasticsearch", "Elasticsearch"],
	["influxdb", "InfluxDB"],
	["graphite", "Graphite"],
	["mysql", "MySQL"],
	["postgres", "PostgreSQL"],
	["grafana-postgresql-datasource", "PostgreSQL"],
	["cloudwatch", "CloudWatch"],
	["jaeger", "Jaeger"],
	["zipkin", "Zipkin"],
	["grafana", "Grafana built-in"],
])

type Query =
	// `note` is what to say about how the query was read, once the panel is imported.
	| { readonly kind: "promql"; readonly expr: string; readonly note?: string }
	| { readonly kind: "clickhouse"; readonly sql: string; readonly note?: string }
	| { readonly kind: "unsupported"; readonly datasource: string }

const ASSUMED_PROMQL =
	"Queries that name no datasource type (the default datasource, or a bare uid) were read as PromQL; check any that are not Prometheus."

const ASSUMED_CLICKHOUSE =
	"SQL queries that name no datasource type (the default datasource, or a bare uid) were read as ClickHouse; check any that are not."

/** What a target queries; an unknown datasource with an `expr` is the default Prometheus. */
function classifyTarget(target: UnknownRecord, panel: UnknownRecord, context: PanelContext): Query {
	const type = datasourceType(target.datasource ?? panel.datasource, context.variables.datasourceTypes)
	const expr = asString(target.expr)
	const sql = asString(target.rawSql) ?? asString(target.query)
	if (expr !== undefined && speaksPromql(type)) {
		const note = promqlPluginNote(type)
		return note === undefined ? { kind: "promql", expr } : { kind: "promql", expr, note }
	}
	// An unresolvable datasource (the default, or a bare uid) is read as Prometheus.
	if (type === undefined && expr !== undefined) return { kind: "promql", expr, note: ASSUMED_PROMQL }
	if (type !== undefined && CLICKHOUSE_TYPES.has(type) && sql !== undefined)
		return { kind: "clickhouse", sql }
	const rawSql = asString(target.rawSql)
	// Read as ClickHouse, the only SQL Maple runs, like the PromQL guess.
	if (type === undefined && rawSql !== undefined)
		return { kind: "clickhouse", sql: rawSql, note: ASSUMED_CLICKHOUSE }
	return {
		kind: "unsupported",
		datasource: DATASOURCE_NAMES.get(type ?? "") ?? type ?? "an unknown datasource",
	}
}

function targetSummary(target: UnknownRecord): string {
	const refId = asString(target.refId) ?? "?"
	const text = asString(target.expr) ?? asString(target.rawSql) ?? asString(target.query)
	return text === undefined ? refId : `${refId}: ${text}`
}

/** A Grafana interval (`30s`, `1m`, `>15s`) in seconds; variables and garbage are `undefined`. */
export function intervalSeconds(value: unknown): number | undefined {
	const match = /^>?\s*(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/u.exec(Str.trim(asString(value) ?? ""))
	if (match === null) return undefined
	const seconds = Number(match[1]) * (UNIT_SECONDS.get(match[2] ?? "s") ?? 1)
	return seconds > 0 ? seconds : undefined
}

const UNIT_SECONDS: ReadonlyMap<string, number> = new Map([
	["ms", 0.001],
	["s", 1],
	["m", 60],
	["h", 3600],
	["d", 86_400],
	["w", 604_800],
])

/** The Maple target for a panel type Maple can draw; charts split into line and bar by draw style. */
function targetFor(panel: UnknownRecord): GrafanaTarget | undefined {
	const meta = widgetTypeByGrafanaType(asString(panel.type))
	if (meta === undefined || meta.panelType === "markdown") return undefined
	if (meta.panelType === "line") return chartStyle(panel).target
	switch (meta.panelType) {
		case "bar":
		case "stat":
		case "gauge":
		case "table":
		case "pie":
		case "heatmap":
		case "histogram":
			return meta.panelType
		default:
			return undefined
	}
}

const VISUALIZATION = {
	line: "chart",
	bar: "chart",
	stat: "stat",
	gauge: "gauge",
	table: "table",
	pie: "pie",
	heatmap: "heatmap",
	histogram: "histogram",
} as const satisfies Record<GrafanaTarget, WidgetVisualization>

const DISPLAY_TYPE = {
	line: "line",
	bar: "bar",
	stat: "stat",
	gauge: "stat",
	table: "table",
	pie: "pie",
	heatmap: "heatmap",
	histogram: "histogram",
} as const satisfies Record<GrafanaTarget, RawSqlDisplayType>

/** A Grafana panel as a widget, or a placeholder note that says why it could not be one. */
export function convertGrafanaPanel(
	panel: UnknownRecord,
	layout: DashboardWidget["layout"],
	context: PanelContext,
): ConvertedPanel {
	const { warnings } = context
	const type = asString(panel.type) ?? "unknown"
	const title = Str.trim(asString(panel.title) ?? "") || "Untitled panel"
	const description = asString(panel.description)
	const id = uniqueWidgetId("grafana", title, context.widgetIds)
	const targets = Arr.filter(
		Arr.flatMap(asArray(panel.targets), (t) => Arr.fromNullishOr(asRecord(t))),
		(t) => t.hide !== true,
	)
	const placeholder = (reason: string, warning?: string): ConvertedPanel => {
		if (warning !== undefined) warnings.push(warning)
		return {
			placeholder: true,
			widget: placeholderWidget({
				source: "Grafana",
				id,
				title,
				description,
				layout,
				reason,
				panelKind: ["Panel type", type],
				querySummaries: Arr.map(targets, targetSummary),
			}),
		}
	}

	if (asString(panel.repeat) !== undefined) {
		warnings.push(
			`Panel "${title}" repeats per value of $${asString(panel.repeat)} in Grafana; Maple shows it once.`,
		)
	}
	if (type === "text") {
		const options = asRecord(panel.options)
		const content = asString(options?.content) ?? asString(panel.content) ?? ""
		if ((asString(options?.mode) ?? asString(panel.mode)) === "html") {
			warnings.push(`Text panel "${title}" is HTML in Grafana; Maple shows it as markdown.`)
		}
		return { placeholder: false, widget: markdownWidget({ id, title, description, content, layout }) }
	}
	if (asRecord(panel.libraryPanel) !== null && asString(panel.type) === undefined) {
		return placeholder(
			"This panel is a Grafana library panel; its definition is not part of the dashboard JSON.",
			`Panel "${title}" is a library panel, which the export does not include; it was imported as a placeholder.`,
		)
	}
	if (type === "logs") {
		return placeholder(
			"Maple has no logs panel for dashboards yet; open the Logs page for these lines.",
			`Logs panel "${title}" was imported as a placeholder.`,
		)
	}
	const target = targetFor(panel)
	if (target === undefined) {
		return placeholder(
			"Maple has no panel like this one yet.",
			`Panel "${title}" uses the "${type}" panel type, which Maple cannot draw; it was imported as a placeholder.`,
		)
	}
	return convertQueryPanel({ panel, target, title, description, id, layout, targets, context, placeholder })
}

function convertQueryPanel(args: {
	panel: UnknownRecord
	target: GrafanaTarget
	title: string
	description: string | undefined
	id: string
	layout: DashboardWidget["layout"]
	targets: ReadonlyArray<UnknownRecord>
	context: PanelContext
	placeholder: (reason: string, warning?: string) => ConvertedPanel
}): ConvertedPanel {
	const { panel, target, title, targets, context } = args
	const [first, ...rest] = targets
	if (first === undefined) {
		return args.placeholder(
			"This panel has no query.",
			`Panel "${title}" has no queries; it was imported as a placeholder.`,
		)
	}
	// Maple widgets hold one query: the first visible target, the rest named so nothing drops silently.
	if (rest.length > 0) {
		context.warnings.push(
			`Panel "${title}" has ${targets.length} queries; Maple imported ${asString(first.refId) ?? "the first"} only. Not imported: ${Arr.join(Arr.map(rest, targetSummary), "; ")}`,
		)
	}
	const query = classifyTarget(first, panel, context)
	const visualization = VISUALIZATION[target]
	const displayType = DISPLAY_TYPE[target]
	if (query.kind === "unsupported") {
		return args.placeholder(
			`This panel queries ${query.datasource}, which Maple cannot run.`,
			`Panel "${title}" queries ${query.datasource}, which Maple cannot run; it was imported as a placeholder.`,
		)
	}
	let dataSource: DashboardWidget["dataSource"]
	if (query.kind === "clickhouse") {
		const normalized = normalizeClickHouseSql(
			rewriteVariableRefs(query.sql, context.variables, "$__interval_s"),
			context.warnings,
			title,
		)
		if ("placeholderReason" in normalized) {
			// normalizeClickHouseSql already said why.
			return args.placeholder(normalized.placeholderReason)
		}
		const transform = grafanaScalarTransform(
			panel,
			visualization,
			displayType,
			title,
			context.warnings,
			true,
		)
		dataSource = rawSqlDataSource({ visualization, sql: normalized.sql, displayType, transform })
	} else {
		// A PromQL widget's heatmap rows keep one value per series, not the time by bucket grid.
		if (target === "heatmap") {
			return args.placeholder(
				"This heatmap needs its buckets over time, which Maple's PromQL widgets do not draw yet.",
				`Heatmap "${title}" was imported as a placeholder: Maple's PromQL widgets cannot draw buckets over time yet.`,
			)
		}
		const legendFormat = asString(first.legendFormat)
		const minStepSeconds = intervalSeconds(first.interval) ?? intervalSeconds(panel.interval)
		const transform = grafanaScalarTransform(panel, visualization, displayType, title, context.warnings)
		dataSource = makePromqlDataSource({
			query: rewriteVariableRefs(query.expr, context.variables, "$__interval"),
			...(legendFormat === undefined || legendFormat === "__auto" ? undefined : { legendFormat }),
			...(minStepSeconds === undefined ? undefined : { minStepSeconds }),
			displayType,
			...(transform === undefined ? undefined : { transform }),
		})
	}
	// Said only of a panel Maple charts; a placeholder has no options to lose and ran no query.
	noteOnce(query.note, context.warnings)
	panelOptionWarnings(panel, first, target, title, context.warnings)
	return {
		placeholder: false,
		widget: {
			id: args.id,
			visualization,
			dataSource,
			display: grafanaDisplay({
				panel,
				target,
				title,
				description: args.description,
				warnings: context.warnings,
			}),
			layout: args.layout,
		},
	}
}

/** Panel and target settings Maple has no equivalent for, named instead of dropped. */
function panelOptionWarnings(
	panel: UnknownRecord,
	first: UnknownRecord,
	target: GrafanaTarget,
	title: string,
	warnings: string[],
) {
	if (asString(panel.type) === "barchart") {
		warnings.push(
			`Bar chart "${title}" groups by a field in Grafana; Maple draws its series as bars over time.`,
		)
	}
	const transformations = Arr.flatMap(asArray(panel.transformations), (item) => {
		const record = asRecord(item)
		return record === null || record.disabled === true ? [] : Arr.fromNullishOr(asString(record.id))
	})
	if (transformations.length > 0) {
		warnings.push(
			`Panel "${title}" applies Grafana transformations (${Arr.join(transformations, ", ")}); Maple shows the query result untransformed.`,
		)
	}
	const overrides = asArray(asRecord(panel.fieldConfig)?.overrides).length
	if (overrides > 0) {
		warnings.push(
			`Panel "${title}" has ${overrides} field override${overrides === 1 ? "" : "s"} in Grafana; Maple applies the panel's defaults to every series.`,
		)
	}
	// Stat, gauge, table and pie rows take each series' latest value, which is what an instant
	// query returns; only a chart draws differently.
	if (first.instant === true && first.range !== true && (target === "line" || target === "bar")) {
		warnings.push(
			`Panel "${title}" runs an instant query in Grafana; Maple charts it over the time range.`,
		)
	}
	if (asString(first.format) === "table" && target !== "table") {
		warnings.push(
			`Panel "${title}" formats its query as a table in Grafana; Maple draws it as a ${target}.`,
		)
	}
}

/** Grafana's `reduceOptions.calcs` to Maple's reducers; `last` reads the first row, as a stat's rows come newest first. */
const GRAFANA_CALCS = new Map<string, "first" | "avg" | "max" | "min" | "sum" | "count">([
	["lastNotNull", "first"],
	["last", "first"],
	["mean", "avg"],
	["max", "max"],
	["min", "min"],
	["sum", "sum"],
	["count", "count"],
])

/** A scalar panel's reducer: Grafana's own calculation where Maple has it, else the latest value. */
function grafanaScalarTransform(
	panel: UnknownRecord,
	visualization: string,
	displayType: string,
	title: string,
	warnings: string[],
	/** Raw SQL rows keep the query's own order, so a "last value" reads whichever row comes first. */
	rowsInQueryOrder = false,
) {
	const transform = scalarTransform(visualization, displayType)
	if (transform === undefined) return undefined
	const calc = asString(asArray(asRecord(asRecord(panel.options)?.reduceOptions)?.calcs)[0])
	const mapped = calc === undefined ? undefined : GRAFANA_CALCS.get(calc)
	// What a missing or unsupported calc falls back to: the first row, which is the latest only when
	// rows come newest first (always for PromQL, only when the query orders them so for raw SQL).
	const shown = rowsInQueryOrder ? "the value of the query's first row" : "the latest value"
	if (calc !== undefined && mapped === undefined) {
		warnings.push(
			`Panel "${title}" reduces with "${calc}", which Maple does not have; it shows ${shown}.`,
		)
	}
	const aggregate = mapped ?? "first"
	if (rowsInQueryOrder && aggregate === "first") {
		warnings.push(
			`Panel "${title}" reads the query's first row as its value; order the query newest first (ORDER BY time DESC) to show the latest.`,
		)
	}
	return mapped === undefined ? transform : { reduceToValue: { field: "value", aggregate } }
}
