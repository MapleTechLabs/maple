// Grafana dashboard JSON to a Maple portable dashboard, with warnings for what did not carry over.
import {
	DashboardValidationError,
	type DashboardRefreshIntervalSeconds,
	PortableDashboardDocument,
	defaultWidgetLayout,
} from "@maple/domain/http"
import { MAX_QUERY_RANGE_SECONDS, validateRelativeRange } from "@maple/query-engine"
import { MAX_IMPORT_REPORT_ITEMS } from "@maple/widgets/dashboard"
import { Effect, Schema, Array as Arr, Order, String as Str } from "effect"
import {
	type DashboardWidget,
	type UnknownRecord,
	asArray,
	asRecord,
	asString,
	uniqueWidgetId,
} from "./dashboard-import-shared"
import { convertGridPos, readGridPos, resolveOverlaps } from "./grafana-import-layout"
import { convertGrafanaPanel, intervalSeconds, type PanelContext } from "./grafana-import-panels"
import { convertGrafanaVariables } from "./grafana-import-variables"
import { panelsFromLegacyRows } from "./grafana-import-legacy"

export interface GrafanaImportStats {
	readonly panels: number
	readonly converted: number
	readonly placeholders: number
}

export interface GrafanaImportConversion {
	readonly dashboard: PortableDashboardDocument
	readonly warnings: readonly string[]
	readonly stats: GrafanaImportStats
}

const decodePortableDashboard = Schema.decodeUnknownSync(PortableDashboardDocument)

/** The dashboard itself: bare, inside the API's `{ dashboard, meta }` envelope, or an export for sharing. */
export function unwrapGrafanaDashboard(input: unknown): UnknownRecord | null {
	const root = asRecord(input)
	const inner = asRecord(root?.dashboard)
	const dashboard = inner ?? root
	if (dashboard === null) return null
	const hasPanels = Arr.isArray(dashboard.panels) || Arr.isArray(dashboard.rows)
	return hasPanels ? dashboard : null
}

/** True for JSON that looks like a Grafana dashboard rather than a Maple or Perses one. */
export const isGrafanaDashboardJson = (input: unknown): boolean => {
	const root = asRecord(input)
	if (root === null) return false
	if (asRecord(root.dashboard) !== null) return unwrapGrafanaDashboard(input) !== null
	return unwrapGrafanaDashboard(input) !== null && root.schemaVersion !== undefined
}

/** `__inputs` of an export for sharing: `DS_PROMETHEUS` to `prometheus`. */
function inputTypes(root: UnknownRecord, dashboard: UnknownRecord): ReadonlyMap<string, string> {
	const inputs = [...asArray(root.__inputs), ...asArray(dashboard.__inputs)]
	return new Map(
		Arr.flatMap(inputs, (input) => {
			const record = asRecord(input)
			const name = asString(record?.name)
			const plugin = asString(record?.pluginId)
			return name === undefined || plugin === undefined ? [] : [[name, plugin] as const]
		}),
	)
}

const DEFAULT_RANGE = "6h"

/** `now-6h` to `now` as Maple's `6h`; Grafana's months are `M`, Maple's `mo`. */
function timeRange(dashboard: UnknownRecord, warnings: string[]) {
	const time = asRecord(dashboard.time)
	const from = asString(time?.from)
	const to = asString(time?.to) ?? "now"
	// "Today" (to the end of the day) and "Today so far" (to now) both start at the day boundary.
	if (from === "now/d" && (to === "now/d" || to === "now"))
		return { type: "relative" as const, value: "today" }
	const match = /^now-(\d+)([mhdwM])$/u.exec(from ?? "")
	const value = match === null ? undefined : `${match[1]}${match[2] === "M" ? "mo" : match[2]}`
	if (value !== undefined && to === "now" && validateRelativeRange(value, MAX_QUERY_RANGE_SECONDS).ok) {
		return { type: "relative" as const, value }
	}
	if (from !== undefined) {
		warnings.push(
			`The time range "${from}" to "${to}" has no Maple equivalent; the dashboard shows the last ${DEFAULT_RANGE}.`,
		)
	}
	return { type: "relative" as const, value: DEFAULT_RANGE }
}

const REFRESH_STEPS: ReadonlyArray<DashboardRefreshIntervalSeconds> = [5, 10, 30, 60, 300, 900]

/** The allowed refresh interval nearest to Grafana's, or none when it was off. */
function refreshInterval(dashboard: UnknownRecord) {
	const seconds = intervalSeconds(dashboard.refresh)
	if (seconds === undefined) return undefined
	return Arr.reduce(REFRESH_STEPS, 900 satisfies DashboardRefreshIntervalSeconds, (best, step) =>
		Math.abs(step - seconds) < Math.abs(best - seconds) ? step : best,
	)
}

const tags = (dashboard: UnknownRecord) =>
	Arr.dedupe([
		...Arr.flatMap(asArray(dashboard.tags), (tag) => Arr.fromNullishOr(asString(tag))),
		"grafana-import",
	])

interface Section {
	readonly id: string
	readonly title: string
	readonly collapsed?: boolean
	readonly tabs: ReadonlyArray<{ readonly id: string; readonly title: string }>
}

/** The container a panel lands in: the root canvas, or a section starting at Grafana row `originY`. */
interface Container {
	readonly sectionId: string | undefined
	readonly originY: number
}

interface PlacedPanel extends Container {
	readonly panel: UnknownRecord
	readonly pos: ReturnType<typeof readGridPos>
}

const MAX_SECTIONS = 50

/** Panels in grid order with positions, a missing `gridPos` stacked below the ones before it. */
function positioned(panels: ReadonlyArray<unknown>) {
	let bottom = 0
	const out = Arr.flatMap(panels, (item) => {
		const panel = asRecord(item)
		if (panel === null) return []
		const pos = readGridPos(panel, bottom)
		bottom = Math.max(bottom, pos.y + pos.h)
		return [{ panel, pos }]
	})
	return Arr.sort(
		out,
		Order.combine(
			Order.mapInput(Order.Number, (entry: (typeof out)[number]) => entry.pos.y),
			Order.mapInput(Order.Number, (entry: (typeof out)[number]) => entry.pos.x),
		),
	)
}

/** Rows become sections; a panel belongs to the row above it, a collapsed row carries its own. */
function placePanels(panels: ReadonlyArray<unknown>, warnings: string[]) {
	const sections: Section[] = []
	const sectionIds = new Set<string>()
	const placed: PlacedPanel[] = []
	let current: Container = { sectionId: undefined, originY: 0 }
	for (const { panel, pos } of positioned(panels)) {
		if (panel.type !== "row") {
			placed.push({ panel, pos, ...current })
			continue
		}
		const title = Str.trim(asString(panel.title) ?? "") || "Row"
		if (sections.length >= MAX_SECTIONS) {
			warnings.push(
				`Row "${title}" was merged into the row above it; Maple holds ${MAX_SECTIONS} sections at most.`,
			)
		} else {
			const id = uniqueWidgetId("grafana-row", title, sectionIds)
			sections.push({
				id,
				title,
				...(panel.collapsed === true ? { collapsed: true } : undefined),
				tabs: [{ id: `${id}-tab`, title }],
			})
			current = { sectionId: id, originY: pos.y + 1 }
		}
		if (asString(panel.repeat) !== undefined) {
			warnings.push(
				`Row "${title}" repeats per value of $${asString(panel.repeat)} in Grafana; Maple shows it once.`,
			)
		}
		for (const nested of positioned(asArray(panel.panels))) placed.push({ ...nested, ...current })
	}
	return { sections, placed }
}

const invalid = (detail: string) =>
	new DashboardValidationError({ message: "Invalid Grafana dashboard", details: [detail] })

/** Widgets per container, laid out on Maple's grid with overlaps pushed down. */
function convertPanels(placed: ReadonlyArray<PlacedPanel>, context: PanelContext) {
	const converted = Arr.map(placed, (entry) => {
		const result = convertGrafanaPanel(entry.panel, { x: 0, y: 0, w: 1, h: 1 }, context)
		const { minW, minH } = defaultWidgetLayout(result.widget.visualization)
		const { layout, grown } = convertGridPos(entry.pos, entry.originY, { minW, minH })
		return { ...result, sectionId: entry.sectionId, layout, grown }
	})
	const widgets: DashboardWidget[] = []
	for (const sectionId of Arr.dedupe(Arr.map(converted, (entry) => entry.sectionId))) {
		const inSection = Arr.filter(converted, (entry) => entry.sectionId === sectionId)
		const layouts = resolveOverlaps(inSection)
		Arr.forEach(inSection, (entry, index) => {
			widgets.push({
				...entry.widget,
				layout: layouts[index] ?? entry.layout,
				...(sectionId === undefined ? undefined : { sectionId, tabId: `${sectionId}-tab` }),
			})
		})
	}
	const placeholders = Arr.filter(converted, (entry) => entry.placeholder).length
	return {
		widgets,
		stats: { panels: converted.length, converted: converted.length - placeholders, placeholders },
	}
}

/** The stored report holds at most `MAX_IMPORT_REPORT_ITEMS`; past that, the last item counts the rest. */
const reportItems = (warnings: ReadonlyArray<string>): ReadonlyArray<string> =>
	warnings.length <= MAX_IMPORT_REPORT_ITEMS
		? warnings
		: [
				...warnings.slice(0, MAX_IMPORT_REPORT_ITEMS - 1),
				`${warnings.length - MAX_IMPORT_REPORT_ITEMS + 1} more items are not listed here.`,
			]

// Returns the validation error rather than failing; unexpected throws are caught by the caller.
function convertSync(input: unknown): GrafanaImportConversion | DashboardValidationError {
	const dashboard = unwrapGrafanaDashboard(input)
	if (dashboard === null) return invalid("Expected a Grafana dashboard with a panels or rows list.")
	const warnings: string[] = []
	const variables = convertGrafanaVariables(
		dashboard.templating,
		inputTypes(asRecord(input) ?? {}, dashboard),
		warnings,
	)
	const legacy = !Arr.isArray(dashboard.panels) && Arr.isArray(dashboard.rows)
	const { sections, placed } = placePanels(
		legacy ? panelsFromLegacyRows(dashboard.rows) : asArray(dashboard.panels),
		warnings,
	)
	if (placed.length === 0) return invalid("The dashboard has no panels to import.")
	const { widgets, stats } = convertPanels(placed, { variables, widgetIds: new Set(), warnings })
	const description = asString(dashboard.description)
	const refresh = refreshInterval(dashboard)
	// Read before the report, since an unmappable range adds a warning.
	const range = timeRange(dashboard, warnings)
	return {
		dashboard: decodePortableDashboard({
			name: Str.trim(asString(dashboard.title) ?? "") || "Imported Grafana dashboard",
			...(description === undefined ? undefined : { description }),
			tags: tags(dashboard),
			timeRange: range,
			...(refresh === undefined ? undefined : { refreshIntervalSeconds: refresh }),
			...(variables.variables.length > 0 ? { variables: variables.variables } : undefined),
			...(sections.length > 0 ? { sections } : undefined),
			widgets,
			// Kept with the board, so what did not import stays visible after this response.
			...(warnings.length > 0
				? { importReport: { source: "grafana", items: reportItems(warnings) } }
				: undefined),
		}),
		warnings,
		stats,
	}
}

export const convertGrafanaDashboardToPortable = Effect.fn("GrafanaDashboardImport.convert")(function* (
	input: unknown,
) {
	const result = yield* Effect.try({
		try: () => convertSync(input),
		catch: (error) =>
			new DashboardValidationError({
				message: "Invalid Grafana dashboard",
				details: [error instanceof Error ? error.message : String(error)],
			}),
	})
	if (Schema.is(DashboardValidationError)(result)) return yield* result
	return result
})
