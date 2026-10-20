import {
	containerKeyFor,
	containerKeyOf,
	type DashboardDocument,
	findNextPosition,
	type SectionTarget,
	withSectionTarget,
} from "@maple/domain/http"
import type { DocumentFields } from "./store"

// The pure layout and widget edits over the stored document.

type Widget = DashboardDocument["widgets"][number]
type Section = NonNullable<DashboardDocument["sections"]>[number]

/** `widgetsInContainer`: the widgets sharing one grid. */
export const widgetsInContainer = (
	widgets: ReadonlyArray<Widget>,
	target: SectionTarget,
): ReadonlyArray<Widget> => {
	const key = containerKeyFor(target)
	return widgets.filter((widget) => containerKeyOf(widget) === key)
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
	const changed = document.widgets.some((widget) => {
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
	const widgets = document.widgets.map((widget) => {
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
	widgets: document.widgets.filter((widget) => widget.id !== widgetId),
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
	const target: SectionTarget =
		source.sectionId !== undefined && source.tabId !== undefined
			? { sectionId: source.sectionId, tabId: source.tabId }
			: null
	const position = findNextPosition(widgetsInContainer(document.widgets, target), source.layout.w)
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
	const position = findNextPosition(widgetsInContainer(document.widgets, target), widget.layout.w)
	const placed: Widget = withSectionTarget({ ...widget, layout: { ...position, ...widget.layout } }, target)
	return { ...document, widgets: [...document.widgets, placed], updatedAt: nowIso }
}

/** `widgetId` from `generateId`: wall clock and a random suffix. */
export const generateWidgetId = (nowMs: number, random: number): string =>
	`${nowMs}-${random.toString(36).slice(2, 9)}`

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
	const keys = [...new Set(sorted.map((widget) => containerKeyOf(widget)))]
	const placed = new Map(
		keys.flatMap((key) => flowContainer(sorted.filter((widget) => containerKeyOf(widget) === key))),
	)
	return sorted.map((widget) => placed.get(widget) ?? widget)
}
