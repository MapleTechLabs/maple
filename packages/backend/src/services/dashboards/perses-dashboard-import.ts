import { Effect, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import {
	DashboardValidationError,
	PortableDashboardDocument,
	type RawSqlDisplayType,
	defaultWidgetLayout,
	findNextPosition,
	widgetTypeByPersesKind,
	type WidgetVisualization,
} from "@maple/domain/http"
import {
	type DashboardWidget,
	type UnknownRecord,
	asArray,
	asFiniteNumber,
	asRecord,
	asString,
	markdownWidget,
	normalizeClickHouseSql,
	placeholderWidget as sharedPlaceholderWidget,
	rawSqlDataSource,
	uniqueWidgetId,
} from "./dashboard-import-shared"

export interface PersesImportConversion {
	readonly dashboard: PortableDashboardDocument
	readonly warnings: readonly string[]
}

const decodePortableDashboard = Schema.decodeUnknownSync(PortableDashboardDocument)

const SUPPORTED_PANEL_KINDS = new Set([
	"Markdown",
	"TimeSeriesChart",
	"BarChart",
	"StatChart",
	"GaugeChart",
	"Table",
	"LogsTable",
	"TimeSeriesTable",
	"PieChart",
	"Histogram",
	"HistogramChart",
	"HeatMap",
	"HeatMapChart",
	"Heatmap",
])

const jsonPointerSegment = (segment: string): string =>
	decodeURIComponent(Str.replace(/~0/g, "~")(Str.replace(/~1/g, "/")(segment)))

function panelKeyFromRef(ref: string): string | null {
	const prefix = "#/spec/panels/"
	if (!Str.startsWith(prefix)(ref)) return null
	return jsonPointerSegment(Str.slice(prefix.length)(ref))
}

function panelKeyFromGridContent(content: unknown): string | null {
	const record = asRecord(content)
	if (!record) return null
	const ref = asString(record.$ref)
	return ref ? panelKeyFromRef(ref) : null
}

function getDisplay(record: UnknownRecord | null) {
	const display = asRecord(record?.display)
	return {
		title: asString(display?.name),
		description: asString(display?.description),
	}
}

function getPanelPlugin(panel: unknown) {
	const panelRecord = asRecord(panel)
	const spec = asRecord(panelRecord?.spec)
	const plugin = asRecord(spec?.plugin)
	return {
		spec,
		kind: asString(plugin?.kind),
		pluginSpec: asRecord(plugin?.spec),
	}
}

// Perses panel `kind` → Maple panel type lives in the shared widget-type table
// (`persesKinds`), so adding a widget kind can't leave the importer behind.
// Unknown kinds fall back to a line chart, as they always have.

const defaultVisualizationForPanelKind = (kind: string | undefined): WidgetVisualization =>
	widgetTypeByPersesKind(kind).visualization

const displayTypeForPanelKind = (kind: string | undefined): RawSqlDisplayType =>
	// Notes carry no SQL rendering; the caller only reaches this for query panels.
	widgetTypeByPersesKind(kind).rawSqlDisplayType ?? "line"

function displayForPanel(args: {
	kind: string | undefined
	title: string
	description?: string
	pluginSpec: UnknownRecord | null
}): Record<string, unknown> {
	const unit = asString(args.pluginSpec?.unit)
	const base: Record<string, unknown> = {
		title: args.title,
		...(args.description ? { description: args.description } : undefined),
		...(unit ? { unit } : undefined),
	} satisfies Record<string, unknown>

	switch (args.kind) {
		// `seriesStats` follows the same rule as the dashboard templates: on for
		// line charts, where the series are levels and the answer is a number;
		// off for stacked bars, where per-series stats under a cumulative plot
		// only duplicate the tooltip. See CHART_DISPLAY_* in dashboard-templates.
		case "TimeSeriesChart":
			return {
				...base,
				chartId: "query-builder-line",
				chartPresentation: { legend: "visible", seriesStats: true },
				stacked: false,
				curveType: "monotone",
			}
		case "BarChart":
			return {
				...base,
				chartId: "query-builder-bar",
				chartPresentation: { legend: "visible", seriesStats: false },
				stacked: true,
				curveType: "linear",
			}
		case "PieChart":
			return { ...base, chartId: "query-builder-pie" }
		case "Histogram":
		case "HistogramChart":
			return { ...base, chartId: "query-builder-histogram" }
		case "HeatMap":
		case "HeatMapChart":
		case "Heatmap":
			return { ...base, chartId: "query-builder-heatmap" }
		case "GaugeChart":
			return {
				...base,
				gauge: {
					...(typeof args.pluginSpec?.min === "number" ? { min: args.pluginSpec.min } : undefined),
					...(typeof args.pluginSpec?.max === "number" ? { max: args.pluginSpec.max } : undefined),
				},
			}
		default:
			return base
	}
}

/**
 * Heights and minimums come from the shared widget-type table. The width does
 * not: a Perses panel with no `gridLayout` entry is a full-row panel in its
 * source dashboard, so everything but a stat imports at the half-width `w: 6`
 * rather than the `w: 4` the web store hands a click-added widget.
 */
function defaultLayoutForVisualization(visualization: string) {
	const { w, h, minW, minH } = defaultWidgetLayout(visualization)
	if (visualization === "stat") return { w, h, minW, minH }
	return { w: 6, h, minW: 3, minH }
}

function nextLayout(widgets: readonly DashboardWidget[], visualization: string) {
	const defaults = defaultLayoutForVisualization(visualization)
	return { ...findNextPosition(widgets, defaults.w), ...defaults }
}

function gridLayoutFromItem(
	item: unknown,
	fallbackVisualization: string,
	yOffset: number,
	warnings: string[],
	panelKey: string,
) {
	const record = asRecord(item)
	const defaults = defaultLayoutForVisualization(fallbackVisualization)
	const rawX = asFiniteNumber(record?.x) ?? 0
	const rawY = asFiniteNumber(record?.y) ?? 0
	const rawW = asFiniteNumber(record?.width) ?? defaults.w
	const rawH = asFiniteNumber(record?.height) ?? defaults.h

	const x = Math.min(11, Math.max(0, Math.floor(rawX)))
	const y = yOffset + Math.max(0, Math.floor(rawY))
	const w = Math.min(12 - x, Math.max(1, Math.floor(rawW)))
	const h = Math.max(2, Math.floor(rawH))

	if (x !== rawX || y !== yOffset + rawY || w !== rawW || h !== rawH) {
		warnings.push(`Clamped layout for Perses panel "${panelKey}" to Maple's 12-column grid.`)
	}

	return { x, y, w, h, minW: defaults.minW, minH: defaults.minH }
}

function queryPluginFromQuery(query: unknown) {
	const queryRecord = asRecord(query)
	const spec = asRecord(queryRecord?.spec)
	const plugin = asRecord(spec?.plugin)
	const pluginSpec = asRecord(plugin?.spec)
	return {
		kind: asString(plugin?.kind),
		query: asString(pluginSpec?.query),
	}
}

function querySummaries(queries: readonly unknown[]): string[] {
	return Arr.map(queries, (query, index) => {
		const plugin = queryPluginFromQuery(query)
		if (plugin.query) {
			return `Query ${index + 1}: ${plugin.kind ?? "UnknownQuery"} - ${plugin.query}`
		}
		return `Query ${index + 1}: ${plugin.kind ?? "UnknownQuery"}`
	})
}

function placeholderWidget(args: {
	id: string
	title: string
	description?: string | undefined
	layout: DashboardWidget["layout"]
	reason: string
	panelKind?: string
	querySummaries?: readonly string[]
}): DashboardWidget {
	return sharedPlaceholderWidget({
		...args,
		source: "Perses",
		panelKind: args.panelKind === undefined ? undefined : ["Panel plugin", args.panelKind],
	})
}

function convertPanel(args: {
	panelKey: string
	panel: unknown
	layout: DashboardWidget["layout"]
	warnings: string[]
	widgetIds: Set<string>
}): DashboardWidget {
	const { spec, kind, pluginSpec } = getPanelPlugin(args.panel)
	const display = getDisplay(spec)
	const title = display.title ?? args.panelKey
	const id = uniqueWidgetId("perses", args.panelKey, args.widgetIds)
	const visualization = defaultVisualizationForPanelKind(kind)

	if (!kind) {
		args.warnings.push(
			`Panel "${title}" is missing a Perses plugin kind and was imported as a placeholder.`,
		)
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This panel is missing a Perses plugin kind.",
		})
	}

	if (!SUPPORTED_PANEL_KINDS.has(kind)) {
		args.warnings.push(`Panel "${title}" uses unsupported Perses plugin "${kind}".`)
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This Perses panel plugin is not supported by the Maple importer yet.",
			panelKind: kind,
			querySummaries: querySummaries(asArray(spec?.queries)),
		})
	}

	if (kind === "Markdown") {
		const text = asString(pluginSpec?.text) ?? ""
		if (!text) {
			args.warnings.push(`Markdown panel "${title}" has no text content.`)
		}
		return markdownWidget({
			id,
			title,
			description: display.description,
			content: text,
			layout: args.layout,
		})
	}

	const queries = asArray(spec?.queries)
	if (queries.length === 0) {
		args.warnings.push(`Panel "${title}" has no queries and was imported as a placeholder.`)
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This Perses panel has no query to execute.",
			panelKind: kind,
		})
	}

	if (queries.length > 1) {
		args.warnings.push(`Panel "${title}" has multiple queries; Maple imported only the first query.`)
	}

	const queryPlugin = queryPluginFromQuery(queries[0])
	if (queryPlugin.kind !== "ClickHouseTimeSeriesQuery" && queryPlugin.kind !== "ClickHouseLogQuery") {
		args.warnings.push(
			`Panel "${title}" uses unsupported query plugin "${queryPlugin.kind ?? "UnknownQuery"}".`,
		)
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This query plugin is not supported by the Maple importer yet.",
			panelKind: kind,
			querySummaries: querySummaries(queries),
		})
	}

	if (!queryPlugin.query) {
		args.warnings.push(
			`Panel "${title}" has an empty ClickHouse query and was imported as a placeholder.`,
		)
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This ClickHouse query is empty.",
			panelKind: kind,
			querySummaries: querySummaries(queries),
		})
	}

	const normalized = normalizeClickHouseSql(queryPlugin.query, args.warnings, title)
	if ("placeholderReason" in normalized) {
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: normalized.placeholderReason,
			panelKind: kind,
			querySummaries: querySummaries(queries),
		})
	}

	return {
		id,
		visualization,
		dataSource: rawSqlDataSource({
			visualization,
			sql: normalized.sql,
			displayType: queryPlugin.kind === "ClickHouseLogQuery" ? "table" : displayTypeForPanelKind(kind),
		}),
		display: displayForPanel({
			kind,
			title,
			description: display.description,
			pluginSpec,
		}),
		layout: args.layout,
	}
}

// Returns the validation error rather than throwing it; unexpected throws are caught by the caller.
function convertSync(input: unknown): PersesImportConversion | DashboardValidationError {
	const root = asRecord(input)
	if (!root || root.kind !== "Dashboard") {
		return new DashboardValidationError({
			message: "Invalid Perses dashboard",
			details: ['Expected a Perses resource with kind "Dashboard".'],
		})
	}

	const spec = asRecord(root.spec)
	if (!spec) {
		return new DashboardValidationError({
			message: "Invalid Perses dashboard",
			details: ["Dashboard spec must be an object."],
		})
	}

	const warnings: string[] = []
	const metadata = asRecord(root.metadata)
	const dashboardDisplay = getDisplay(spec)
	const name = dashboardDisplay.title ?? asString(metadata?.name) ?? "Imported Perses Dashboard"
	const description = dashboardDisplay.description
	const duration = asString(spec.duration)

	if (!duration) {
		warnings.push('Perses duration is missing or invalid; Maple defaulted the dashboard range to "12h".')
	}

	if (asArray(spec.variables).length > 0) {
		warnings.push("Perses dashboard variables are not imported; affected queries may need manual edits.")
	}

	if (Rec.keys(asRecord(spec.datasources) ?? {}).length > 0) {
		warnings.push(
			"Perses datasource definitions are not stored; imported ClickHouse widgets run through Maple raw SQL.",
		)
	}

	const panels = asRecord(spec.panels)
	if (!panels || Rec.keys(panels).length === 0) {
		return new DashboardValidationError({
			message: "Invalid Perses dashboard",
			details: ["Dashboard spec.panels must contain at least one panel."],
		})
	}

	const widgets: DashboardWidget[] = []
	const widgetIds = new Set<string>()
	const placedPanels = new Set<string>()
	let yOffset = 0
	const layouts = asArray(spec.layouts)

	for (const [layoutIndex, layout] of layouts.entries()) {
		const layoutRecord = asRecord(layout)
		if (layoutRecord?.kind !== "Grid") {
			warnings.push(
				`Unsupported Perses layout at index ${layoutIndex}; only Grid layouts are imported.`,
			)
			continue
		}

		const items = asArray(asRecord(layoutRecord.spec)?.items)
		let gridBottom = yOffset
		for (const [itemIndex, item] of items.entries()) {
			const itemRecord = asRecord(item)
			const panelKey = panelKeyFromGridContent(itemRecord?.content)
			if (!panelKey) {
				warnings.push(
					`Grid item ${layoutIndex}.${itemIndex} does not reference a panel and was skipped.`,
				)
				continue
			}

			const panel = panels[panelKey]
			if (!panel) {
				warnings.push(`Grid item ${layoutIndex}.${itemIndex} references missing panel "${panelKey}".`)
				continue
			}

			const panelKind = getPanelPlugin(panel).kind
			const visualization = defaultVisualizationForPanelKind(panelKind)
			const layoutForWidget = gridLayoutFromItem(item, visualization, yOffset, warnings, panelKey)
			const widget = convertPanel({ panelKey, panel, layout: layoutForWidget, warnings, widgetIds })
			widgets.push(widget)
			placedPanels.add(panelKey)
			gridBottom = Math.max(gridBottom, layoutForWidget.y + layoutForWidget.h)
		}
		yOffset = Math.max(yOffset, gridBottom)
	}

	if (layouts.length === 0) {
		warnings.push("Perses dashboard has no layouts; Maple generated layouts for imported panels.")
	}

	for (const [panelKey, panel] of Rec.toEntries(panels)) {
		if (placedPanels.has(panelKey)) continue
		const panelKind = getPanelPlugin(panel).kind
		const visualization = defaultVisualizationForPanelKind(panelKind)
		const layout = nextLayout(widgets, visualization)
		warnings.push(
			`Panel "${panelKey}" was not referenced by a layout; Maple generated a position for it.`,
		)
		widgets.push(convertPanel({ panelKey, panel, layout, warnings, widgetIds }))
	}

	return {
		dashboard: decodePortableDashboard({
			name,
			...(description ? { description } : undefined),
			tags: ["perses-import"],
			timeRange: { type: "relative", value: duration ?? "12h" },
			widgets,
		}),
		warnings,
	}
}

export const convertPersesDashboardToPortable = Effect.fn("PersesDashboardImport.convert")(function* (
	input: unknown,
) {
	const result = yield* Effect.try({
		try: () => convertSync(input),
		catch: (error) =>
			new DashboardValidationError({
				message: "Invalid Perses dashboard",
				details: [error instanceof Error ? error.message : String(error)],
			}),
	})
	if (Schema.is(DashboardValidationError)(result)) return yield* result
	return result
})
