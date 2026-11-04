import {
	containerKeyFor,
	containerKeyOf,
	type DashboardDocument,
	findNextPosition,
	type SectionTarget,
	withSectionTarget,
} from "@maple/domain/http"
import { groupWidgetsByContainer } from "@maple/widgets/dashboard"
import type { DocumentFields } from "./store"
import { Array as Arr, String as Str } from "effect"

// The pure layout and widget edits over the stored document.

type Widget = DashboardDocument["widgets"][number]
type Section = NonNullable<DashboardDocument["sections"]>[number]

type Sectioned = Pick<DashboardDocument, "widgets" | "sections">

/** `widgetsInContainer`: the widgets sharing one grid, as drawn (a vanished group's tiles are root). */
export const widgetsInContainer = (document: Sectioned, target: SectionTarget): ReadonlyArray<Widget> =>
	groupWidgetsByContainer(document).get(containerKeyFor(target)) ?? []

/** The grid a widget draws in: its container, or the root when that container is gone. */
const drawnKeyOf = (sections: ReadonlyArray<Section>) => {
	const keys = new Set(
		Arr.flatMap(sections, (section) =>
			Arr.map(section.tabs, (tab) => containerKeyFor({ sectionId: section.id, tabId: tab.id })),
		),
	)
	return (widget: Widget): string => {
		const key = containerKeyOf(widget)
		return keys.has(key) ? key : containerKeyFor(null)
	}
}

/** `containerRank`: root first, then sections and tabs in order; a vanished container ranks as root. */
const containerRank = (widget: Widget, sections: ReadonlyArray<Section>): number => {
	if (widget.sectionId === undefined || widget.tabId === undefined) return -1
	const sectionIndex = sections.findIndex((section) => section.id === widget.sectionId)
	if (sectionIndex === -1) return -1
	const tabIndex = sections[sectionIndex]?.tabs.findIndex((tab) => tab.id === widget.tabId) ?? -1
	return tabIndex === -1 ? -1 : sectionIndex * 1000 + tabIndex
}

/** `sortWidgetsForLayout`: array order matches visual order, container first. */
export const sortWidgetsForLayout = (
	widgets: ReadonlyArray<Widget>,
	sections: ReadonlyArray<Section>,
): ReadonlyArray<Widget> =>
	widgets.toSorted((a, b) => {
		const rankDelta = containerRank(a, sections) - containerRank(b, sections)
		if (rankDelta !== 0) return rankDelta
		if (a.layout.y !== b.layout.y) return a.layout.y - b.layout.y
		return a.layout.x - b.layout.x
	})

export type LayoutChange = Readonly<{ i: string; x: number; y: number; w: number; h: number }>

/** `updateWidgetLayouts`: the changed boxes written in, the widgets re-sorted; unchanged is `null`. */
export const withLayouts = (
	document: DashboardDocument,
	layouts: ReadonlyArray<LayoutChange>,
	nowIso: DashboardDocument["updatedAt"],
): DocumentFields | null => {
	const changed = Arr.some(document.widgets, (widget) => {
		const layout = layouts.find((item) => item.i === widget.id)
		return (
			layout !== undefined &&
			(widget.layout.x !== layout.x ||
				widget.layout.y !== layout.y ||
				widget.layout.w !== layout.w ||
				widget.layout.h !== layout.h)
		)
	})
	if (!changed) return null
	const widgets = Arr.map(document.widgets, (widget) => {
		const layout = layouts.find((item) => item.i === widget.id)
		return layout === undefined
			? widget
			: { ...widget, layout: { ...widget.layout, x: layout.x, y: layout.y, w: layout.w, h: layout.h } }
	})
	return {
		...document,
		widgets: sortWidgetsForLayout(widgets, document.sections ?? []),
		updatedAt: nowIso,
	}
}

/** `removeWidget`. */
export const withoutWidget = (
	document: DashboardDocument,
	widgetId: string,
	nowIso: DashboardDocument["updatedAt"],
): DocumentFields => ({
	...document,
	widgets: Arr.filter(document.widgets, (widget) => widget.id !== widgetId),
	updatedAt: nowIso,
})

/** `cloneWidget`: a copy beside its source, in the same container, under a fresh id. */
export const withClone = (
	document: DashboardDocument,
	widgetId: string,
	newId: string,
	nowIso: DashboardDocument["updatedAt"],
): DocumentFields => {
	const source = document.widgets.find((widget) => widget.id === widgetId)
	if (source === undefined) return document
	// The copy lands where its source draws: a source in a vanished group draws (and copies) as root.
	const isDrawnInGroup =
		source.sectionId !== undefined &&
		source.tabId !== undefined &&
		drawnKeyOf(document.sections ?? [])(source) !== containerKeyFor(null)
	const target: SectionTarget =
		isDrawnInGroup && source.sectionId !== undefined && source.tabId !== undefined
			? { sectionId: source.sectionId, tabId: source.tabId }
			: null
	const position = findNextPosition(widgetsInContainer(document, target), source.layout.w)
	const placed: Widget = {
		id: newId,
		visualization: source.visualization,
		dataSource: structuredClone(source.dataSource),
		display: structuredClone(source.display),
		layout: {
			...position,
			w: source.layout.w,
			h: source.layout.h,
			minW: source.layout.minW ?? 2,
			minH: source.layout.minH ?? 2,
		},
	}
	return {
		...document,
		widgets: [...document.widgets, withSectionTarget(placed, target)],
		updatedAt: nowIso,
	}
}

/** `addWidget`: the next free slot for its default size, in the grid it is dropped into. */
export const withAddedWidget = (
	document: DashboardDocument,
	widget: Omit<Widget, "layout"> & { readonly layout: Omit<Widget["layout"], "x" | "y"> },
	nowIso: DashboardDocument["updatedAt"],
	target: SectionTarget = null,
): DocumentFields => {
	const position = findNextPosition(widgetsInContainer(document, target), widget.layout.w)
	const placed: Widget = withSectionTarget({ ...widget, layout: { ...position, ...widget.layout } }, target)
	return { ...document, widgets: [...document.widgets, placed], updatedAt: nowIso }
}

/** `widgetId` from `generateId`: wall clock and a random suffix. */
export const generateWidgetId = (nowMs: number, random: number): string =>
	`${nowMs}-${Str.slice(2, 9)(random.toString(36))}`

/** `CANONICAL_COLS`: the editable canvas's width in columns. */
const CANONICAL_COLS = 12

type Flow = Readonly<{
	x: number
	y: number
	rowHeight: number
	placed: ReadonlyArray<readonly [Widget, Widget]>
}>

/** One container re-flowed from (0, 0): left to right in reading order, wrapping at the canvas width. */
const flowContainer = (bucket: ReadonlyArray<Widget>): Flow["placed"] =>
	bucket.reduce<Flow>(
		(flow, widget) => {
			const { w, h } = widget.layout
			const wraps = flow.x + w > CANONICAL_COLS
			const x = wraps ? 0 : flow.x
			const y = wraps ? flow.y + flow.rowHeight : flow.y
			return {
				x: x + w,
				y,
				rowHeight: wraps ? h : Math.max(flow.rowHeight, h),
				placed: [...flow.placed, [widget, { ...widget, layout: { ...widget.layout, x, y } }]],
			}
		},
		{ x: 0, y: 0, rowHeight: 0, placed: [] },
	).placed

/**
 * `autoLayoutPerContainer`: every container re-flowed on its own, in the board's sorted order.
 * Keyed by the widget object, not its id: stored ids are not validated unique.
 */
export const autoLaidOut = (
	widgets: ReadonlyArray<Widget>,
	sections: ReadonlyArray<Section>,
): ReadonlyArray<Widget> => {
	const sorted = sortWidgetsForLayout(widgets, sections)
	const keyOf = drawnKeyOf(sections)
	const keys = [...new Set(Arr.map(sorted, keyOf))]
	const placed = new Map(
		Arr.flatMap(keys, (key) => flowContainer(Arr.filter(sorted, (widget) => keyOf(widget) === key))),
	)
	return Arr.map(sorted, (widget) => placed.get(widget) ?? widget)
}
