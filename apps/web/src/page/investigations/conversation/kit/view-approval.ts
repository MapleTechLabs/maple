import { WIDGET_TYPES } from "@maple/domain/http"
import { EMPTY_VALUE, countLabel } from "@maple/ui/lib/format"
import { asArray, asRecord, asString, safeParseJson } from "./approval-parse"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../../ui/display"
import { eyebrow } from "../../../../ui/eyebrow"
import { icon, type IconName } from "../../../../ui/icon"
import { inlineCode } from "../../../../ui/inline-code"
import { panel } from "../../../../ui/panel"

// The dashboard tools' approval summaries.
// Icons and labels follow the widget-type registry (`widgetTypeFor`): `chart` and unknown kinds read as a line.

const ICONS = new Map<string, IconName>([
	["line", "ChartLineIcon"],
	["bar", "ChartBarIcon"],
	["area", "ChartBarTrendUpIcon"],
	["pie", "CirclePercentageIcon"],
	["funnel", "ArrowTrendDownIcon"],
	["hbar", "ChartBarHorizontalIcon"],
	["heatmap", "LayersIcon"],
	["histogram", "ChartBarIcon"],
	["gauge", "SlidersIcon"],
	["markdown", "FileIcon"],
	["table", "GridIcon"],
	["list", "MenuIcon"],
	["paths", "BranchForkIcon"],
	["stat", "CirclePercentageIcon"],
])

const LABELS = new Map<string, string>(Object.entries(WIDGET_TYPES).map(([type, meta]) => [type, meta.label]))

const panelTypeOf = (visualization: string): string => (ICONS.has(visualization) ? visualization : "line")
const vizIcon = (visualization: string): IconName => ICONS.get(panelTypeOf(visualization)) ?? "ChartLineIcon"
const vizLabel = (visualization: string): string => LABELS.get(panelTypeOf(visualization)) ?? "Line"

type Widget = Readonly<{ visualization: string; title: string; source?: string; groupBy?: string }>

const normalizeWidget = (raw: unknown): ReadonlyArray<Widget> => {
	const obj = asRecord(raw)
	if (obj === undefined) return []
	const display = asRecord(obj.display)
	const dataSource = asRecord(obj.dataSource)
	const params = asRecord(dataSource?.params)
	const source = asString(dataSource?.endpoint) ?? asString(obj.source) ?? asString(params?.source)
	const groupBy = asString(params?.group_by) ?? asString(obj.group_by)
	return [
		{
			visualization: asString(obj.visualization) ?? "chart",
			title: asString(display?.title) ?? asString(obj.title) ?? "Untitled widget",
			...(source === undefined ? undefined : { source }),
			...(groupBy === undefined ? undefined : { groupBy }),
		},
	]
}

/** A JSON-string argument parsed to an object or a list; anything else is absent. */
const parsedRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
	const result = safeParseJson(value)
	return result.ok ? asRecord(result.value) : undefined
}

const parsedArray = (value: unknown): ReadonlyArray<unknown> | undefined => {
	const result = safeParseJson(value)
	return result.ok ? asArray(result.value) : undefined
}

const widgetRow = <M>(h: HtmlBuilder<M>, widget: Widget): Html =>
	h.div(
		[h.Class("flex items-center gap-2 rounded-md border border-border-subtle bg-background/60 px-2 py-1.5")],
		[
			icon(h, vizIcon(widget.visualization), { className: "size-3.5 shrink-0 text-muted-foreground" }),
			h.span([h.Class("truncate text-xs font-medium")], [widget.title]),
			...(widget.source === undefined
				? []
				: [h.span([h.Class("truncate text-2xs text-muted-foreground")], [widget.source])]),
			...(widget.groupBy === undefined
				? []
				: [
						badge(h, { variant: "outline", size: "xs", className: "ml-auto px-1.5" }, [
							widget.groupBy,
						]),
					]),
		],
	)

const widgetList = <M>(h: HtmlBuilder<M>, widgets: ReadonlyArray<Widget>, max = 8): ReadonlyArray<Html> => {
	if (widgets.length === 0) return []
	const overflow = widgets.length - Math.min(max, widgets.length)
	return [
		h.div(
			[h.Class("space-y-1")],
			[
				...widgets.slice(0, max).map((widget) => widgetRow(h, widget)),
				...(overflow > 0
					? [
							h.div(
								[h.Class("px-2 text-2xs text-muted-foreground")],
								["+ ", String(overflow), " more"],
							),
						]
					: []),
			],
		),
	]
}

const section = <M>(h: HtmlBuilder<M>, title: string, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("space-y-1.5")], [eyebrow(h, { as: "div" }, [title]), ...children])

const fieldChip = <M>(h: HtmlBuilder<M>, label: string, value: string): Html =>
	badge(h, { variant: "outline", className: "gap-1 font-normal" }, [
		h.span([h.Class("text-muted-foreground")], [label]),
		h.span([h.Class("font-mono")], [value]),
	])

const heading = <M>(
	h: HtmlBuilder<M>,
	glyph: IconName,
	title: ReadonlyArray<string>,
	dashboardId: string | null,
): Html =>
	h.div(
		[h.Class("flex items-center gap-2")],
		[
			icon(h, glyph, { className: "size-3.5 shrink-0 text-muted-foreground" }),
			h.span([h.Class("text-sm font-semibold")], title),
			...(dashboardId === null
				? []
				: [
						badge(h, { variant: "outline", size: "xs", mono: true, className: "ml-auto" }, [
							dashboardId,
						]),
					]),
		],
	)

/** `deriveWidgetsFromCreate`: the widgets of a `dashboard_json`, else of a `widgets` list. */
const widgetsOf = (input: Readonly<Record<string, unknown>>): ReadonlyArray<Widget> => {
	const dashboard = safeParseJson(input.dashboard_json)
	if (dashboard.ok) return (asArray(asRecord(dashboard.value)?.widgets) ?? []).flatMap(normalizeWidget)
	const simple = safeParseJson(input.widgets)
	return simple.ok ? (asArray(simple.value) ?? []).flatMap(normalizeWidget) : []
}

type Input = Readonly<Record<string, unknown>>

const createDashboard = <M>(h: HtmlBuilder<M>, obj: Input): Html => {
	const name = asString(obj.name) ?? "Untitled dashboard"
	const description = asString(obj.description)
	const serviceName = asString(obj.service_name)
	const isCustom = Boolean(obj.dashboard_json) || Boolean(obj.widgets)
	const widgets = widgetsOf(obj)
	const inner = parsedRecord(obj.dashboard_json)
	const innerName = asString(inner?.name) ?? asString(inner?.title)
	return h.div(
		[h.Class("space-y-3")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					icon(h, "PlusIcon", { className: "size-3.5 shrink-0 text-muted-foreground" }),
					h.div(
						[h.Class("min-w-0 flex-1")],
						[
							h.div([h.Class("truncate text-sm font-semibold")], [name]),
							...(innerName !== undefined && innerName !== name
								? [
										h.div(
											[h.Class("truncate text-2xs text-muted-foreground")],
											["Inner title: ", innerName],
										),
									]
								: []),
						],
					),
				],
			),
			...(description === undefined
				? []
				: [h.div([h.Class("text-xs text-muted-foreground")], [description])]),
			h.div(
				[h.Class("flex flex-wrap gap-1.5")],
				[
					fieldChip(
						h,
						"template",
						asString(obj.template) ?? (isCustom ? "Custom" : "service-health"),
					),
					...(serviceName === undefined ? [] : [fieldChip(h, "service", serviceName)]),
					fieldChip(h, "time", asString(obj.time_range) ?? "1h"),
				],
			),
			...(widgets.length > 0
				? [section(h, `Widgets (${widgets.length})`, widgetList(h, widgets))]
				: !isCustom
					? [
							h.div(
								[
									h.Class(
										"rounded-md border border-dashed border-border-subtle px-2 py-1.5 text-2xs text-muted-foreground",
									),
								],
								["Template will generate widgets automatically."],
							),
						]
					: []),
		],
	)
}

const changeLine = <M>(h: HtmlBuilder<M>, label: string, value: string, valueClass?: string): Html =>
	h.div(
		[h.Class("text-xs")],
		[
			h.span([h.Class("text-muted-foreground")], [label]),
			h.span(valueClass === undefined ? [] : [h.Class(valueClass)], [value]),
		],
	)

const updateDashboard = <M>(h: HtmlBuilder<M>, obj: Input): Html => {
	const name = asString(obj.name)
	const description = asString(obj.description)
	const timeRange = asString(obj.time_range)
	const isReplacement = Boolean(obj.dashboard_json)
	const widgets = isReplacement ? widgetsOf(obj) : []
	return h.div(
		[h.Class("space-y-3")],
		[
			heading(h, "PencilIcon", ["Update dashboard"], asString(obj.dashboard_id) ?? EMPTY_VALUE),
			h.div(
				[h.Class("space-y-1")],
				[
					...(name === undefined ? [] : [changeLine(h, "New name: ", name, "font-medium")]),
					...(description === undefined ? [] : [changeLine(h, "New description: ", description)]),
					...(timeRange === undefined
						? []
						: [changeLine(h, "New time range: ", timeRange, "font-mono")]),
					...(name === undefined &&
					description === undefined &&
					timeRange === undefined &&
					!isReplacement
						? [h.div([h.Class("text-xs text-muted-foreground")], ["No metadata changes"])]
						: []),
				],
			),
			...(isReplacement
				? [
						section(
							h,
							widgets.length > 0
								? `Full replacement · ${countLabel(widgets.length, "widget")}`
								: "Full replacement",
							[
								h.div(
									[h.Class("mb-1.5")],
									[
										badge(h, { variant: "destructive", size: "xs" }, [
											"Replaces entire dashboard",
										]),
									],
								),
								...widgetList(h, widgets),
							],
						),
					]
				: []),
		],
	)
}

/** `layout_json` as `x,y · w×h`, else auto-placed. */
const layoutLabel = (layout: Input | undefined): string => {
	if (layout === undefined) return "auto-placed"
	const { x, y, w, h } = layout
	return typeof x === "number" && typeof y === "number" && typeof w === "number" && typeof h === "number"
		? `${x},${y} · ${w}×${h}`
		: "auto-placed"
}

const addWidget = <M>(h: HtmlBuilder<M>, obj: Input): Html => {
	const visualization = asString(obj.visualization) ?? "chart"
	const display = parsedRecord(obj.display_json)
	const dataSource = parsedRecord(obj.data_source_json)
	const endpoint = asString(dataSource?.endpoint)
	const serviceName = asString(asRecord(dataSource?.params)?.service_name)
	return h.div(
		[h.Class("space-y-3")],
		[
			heading(h, "PlusIcon", ["Add widget"], asString(obj.dashboard_id) ?? EMPTY_VALUE),
			panel(h, { tone: "background", className: "border-border-subtle bg-background/60 p-2" }, [
				h.div(
					[h.Class("flex items-center gap-2")],
					[
						icon(h, vizIcon(visualization), {
							className: "size-4 shrink-0 text-muted-foreground",
						}),
						h.div(
							[h.Class("min-w-0 flex-1")],
							[
								h.div(
									[h.Class("truncate text-xs font-medium")],
									[asString(display?.title) ?? "Untitled widget"],
								),
								...(endpoint === undefined
									? []
									: [
											h.div(
												[h.Class("truncate text-2xs text-muted-foreground")],
												[endpoint],
											),
										]),
							],
						),
					],
				),
			]),
			h.div(
				[h.Class("flex flex-wrap gap-1.5")],
				[
					fieldChip(h, "viz", vizLabel(visualization)),
					...(serviceName === undefined ? [] : [fieldChip(h, "service", serviceName)]),
					fieldChip(h, "layout", layoutLabel(parsedRecord(obj.layout_json))),
				],
			),
		],
	)
}

const updateWidget = <M>(h: HtmlBuilder<M>, obj: Input): Html => {
	const visualization = asString(obj.visualization)
	const display = parsedRecord(obj.display_json)
	const dataSource = parsedRecord(obj.data_source_json)
	const layout = parsedRecord(obj.layout_json)
	const title = asString(display?.title)
	const endpoint = asString(dataSource?.endpoint)
	const changes: ReadonlyArray<Readonly<{ label: string; detail: string | undefined }>> = [
		...(visualization === undefined ? [] : [{ label: "Visualization", detail: visualization }]),
		...(display === undefined
			? []
			: [{ label: "Display config", detail: title === undefined ? undefined : `title: ${title}` }]),
		...(dataSource === undefined
			? []
			: [
					{
						label: "Data source",
						detail: endpoint === undefined ? undefined : `endpoint: ${endpoint}`,
					},
				]),
		...(layout === undefined ? [] : [{ label: "Layout", detail: undefined }]),
	]
	return h.div(
		[h.Class("space-y-3")],
		[
			heading(h, "PencilIcon", ["Update widget"], null),
			h.div(
				[h.Class("flex flex-wrap gap-1.5")],
				[
					fieldChip(h, "dashboard", asString(obj.dashboard_id) ?? EMPTY_VALUE),
					fieldChip(h, "widget", asString(obj.widget_id) ?? EMPTY_VALUE),
				],
			),
			section(h, `Changes (${changes.length})`, [
				changes.length === 0
					? h.div([h.Class("text-xs text-muted-foreground")], ["No changes"])
					: h.ul(
							[h.Class("space-y-1 text-xs")],
							changes.map(({ label, detail }) =>
								h.li(
									[h.Class("flex gap-2")],
									[
										h.span([h.Class("font-medium")], [label]),
										...(detail === undefined
											? []
											: [
													h.span(
														[h.Class("truncate text-muted-foreground")],
														[detail],
													),
												]),
									],
								),
							),
						),
			]),
		],
	)
}

const removeWidget = <M>(h: HtmlBuilder<M>, obj: Input): Html =>
	h.div(
		[h.Class("flex items-start gap-2")],
		[
			icon(h, "TrashIcon", { className: "mt-0.5 size-3.5 shrink-0 text-destructive" }),
			h.div(
				[h.Class("text-xs leading-relaxed")],
				[
					"Remove widget ",
					inlineCode(h, {}, [asString(obj.widget_id) ?? EMPTY_VALUE]),
					" from dashboard",
					" ",
					inlineCode(h, {}, [asString(obj.dashboard_id) ?? EMPTY_VALUE]),
					".",
				],
			),
		],
	)

const reorderWidgets = <M>(h: HtmlBuilder<M>, obj: Input): Html => {
	const ids = (parsedArray(obj.layouts_json) ?? []).flatMap((entry) => {
		const id = asString(asRecord(entry)?.id)
		return id === undefined ? [] : [id]
	})
	const preview = ids.slice(0, 4)
	const overflow = ids.length - preview.length
	return h.div(
		[h.Class("space-y-2")],
		[
			heading(
				h,
				"GridIcon",
				["Reorder ", ids.length > 0 ? countLabel(ids.length, "widget") : "widgets"],
				asString(obj.dashboard_id) ?? EMPTY_VALUE,
			),
			...(preview.length === 0
				? []
				: [
						h.div(
							[h.Class("flex flex-wrap gap-1")],
							[
								...preview.map((id) =>
									inlineCode(
										h,
										{ className: "px-1.5 py-0.5 text-3xs text-muted-foreground" },
										[id],
									),
								),
								...(overflow > 0
									? [
											h.span(
												[h.Class("text-3xs text-muted-foreground")],
												["+ ", String(overflow), " more"],
											),
										]
									: []),
							],
						),
					]),
		],
	)
}

const SUMMARIES = new Map<string, <M>(h: HtmlBuilder<M>, obj: Input) => Html>([
	["create_dashboard", createDashboard],
	["update_dashboard", updateDashboard],
	["add_dashboard_widget", addWidget],
	["update_dashboard_widget", updateWidget],
	["remove_dashboard_widget", removeWidget],
	["reorder_dashboard_widgets", reorderWidgets],
])

/** `ApprovalSummary`'s registered renderers; `null` for a tool that falls back to the key-value list. */
export const dashboardSummary = <M>(h: HtmlBuilder<M>, toolName: string, input: unknown): Html | null => {
	const summary = SUMMARIES.get(toolName)
	return summary === undefined ? null : summary(h, asRecord(input) ?? {})
}
