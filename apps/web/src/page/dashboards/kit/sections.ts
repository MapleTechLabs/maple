import {
	type DashboardDocument,
	findNextPosition,
	type SectionTarget,
	withSectionTarget,
} from "@maple/domain/http"
import { sortWidgetsForLayout, widgetsInContainer } from "./layout"
import type { DocumentFields } from "./store"
import { Array as Arr, Option } from "effect"

// The dashboard section edits as pure
// document updaters; an edit that changes nothing hands the document back unchanged.

type Section = NonNullable<DashboardDocument["sections"]>[number]
type Widget = DashboardDocument["widgets"][number]
type NowIso = DashboardDocument["updatedAt"]

const touch = (
	document: DashboardDocument,
	sections: ReadonlyArray<Section>,
	nowIso: NowIso,
): DocumentFields => ({
	...document,
	sections,
	updatedAt: nowIso,
})

const mapSection = (
	document: DashboardDocument,
	sectionId: string,
	nowIso: NowIso,
	update: (section: Section) => Section,
): DocumentFields => {
	const sections = document.sections ?? []
	if (!Arr.some(sections, (section) => section.id === sectionId)) return document
	return touch(
		document,
		Arr.map(sections, (section) => (section.id === sectionId ? update(section) : section)),
		nowIso,
	)
}

/** `addSection`: one tab, so it renders as a plain header until someone asks for tabs. */
export const withAddedSection = (
	document: DashboardDocument,
	ids: Readonly<{ sectionId: string; tabId: string }>,
	nowIso: NowIso,
	title = "New group",
): DocumentFields =>
	touch(
		document,
		[...(document.sections ?? []), { id: ids.sectionId, title, tabs: [{ id: ids.tabId, title }] }],
		nowIso,
	)

/** `renameSection`: with a single tab the header is the tab label, so both move together. */
export const withRenamedSection = (
	document: DashboardDocument,
	sectionId: string,
	title: string,
	nowIso: NowIso,
) =>
	mapSection(document, sectionId, nowIso, (section) => {
		const [only] = section.tabs
		return section.tabs.length === 1 && only !== undefined
			? { ...section, title, tabs: [{ ...only, title }] }
			: { ...section, title }
	})

export const withSectionCollapsedDefault = (
	document: DashboardDocument,
	sectionId: string,
	collapsed: boolean,
	nowIso: NowIso,
) => mapSection(document, sectionId, nowIso, (section) => ({ ...section, collapsed }))

/** `setSectionCollapsible`: pinning a group open clears its collapsed default. */
export const withSectionCollapsible = (
	document: DashboardDocument,
	sectionId: string,
	collapsible: boolean,
	nowIso: NowIso,
) =>
	mapSection(document, sectionId, nowIso, (section) => {
		if (collapsible) return { ...section, collapsible }
		const { collapsed: _collapsed, ...rest } = section
		return { ...rest, collapsible }
	})

export const withReorderedSections = (
	document: DashboardDocument,
	fromIndex: number,
	toIndex: number,
	nowIso: NowIso,
): DocumentFields => {
	const sections = document.sections ?? []
	const moved = sections[fromIndex]
	if (fromIndex === toIndex || moved === undefined || toIndex < 0 || toIndex >= sections.length)
		return document
	const without = Arr.filter(sections, (_, index) => index !== fromIndex)
	return touch(document, [...without.slice(0, toIndex), moved, ...without.slice(toIndex)], nowIso)
}

const rootBottom = (document: DashboardDocument): number => {
	const root = widgetsInContainer(document, null)
	return root.length === 0 ? 0 : Math.max(...Arr.map(root, (widget) => widget.layout.y + widget.layout.h))
}

/** `ungroupSectionWidgets`: the group's tiles land on the root canvas below what is there. */
const ungroup = (document: DashboardDocument, sectionId: string): ReadonlyArray<Widget> => {
	const offset = rootBottom(document)
	return Arr.map(document.widgets, (widget) => {
		if (widget.sectionId !== sectionId) return widget
		const moved = withSectionTarget(widget, null)
		return { ...moved, layout: { ...moved.layout, y: moved.layout.y + offset } }
	})
}

/** `deleteSection`: keep the widgets (ungrouped) or remove them with the group. */
export const withoutSection = (
	document: DashboardDocument,
	sectionId: string,
	action: "ungroup" | "delete",
	nowIso: NowIso,
): DocumentFields => {
	const sections = document.sections ?? []
	if (!Arr.some(sections, (section) => section.id === sectionId)) return document
	return {
		...touch(
			document,
			Arr.filter(sections, (section) => section.id !== sectionId),
			nowIso,
		),
		widgets:
			action === "ungroup"
				? ungroup(document, sectionId)
				: Arr.filter(document.widgets, (widget) => widget.sectionId !== sectionId),
	}
}

export const withAddedTab = (
	document: DashboardDocument,
	sectionId: string,
	tabId: string,
	nowIso: NowIso,
	title = "New tab",
) =>
	mapSection(document, sectionId, nowIso, (section) => ({
		...section,
		tabs: [...section.tabs, { id: tabId, title }],
	}))

/** `renameTab`: renaming the only tab renames the group with it. */
export const withRenamedTab = (
	document: DashboardDocument,
	sectionId: string,
	tabId: string,
	title: string,
	nowIso: NowIso,
) =>
	mapSection(document, sectionId, nowIso, (section) => {
		const tabs = Arr.map(section.tabs, (tab) => (tab.id === tabId ? { ...tab, title } : tab))
		return tabs.length === 1 ? { ...section, title, tabs } : { ...section, tabs }
	})

/**
 * `deleteTab`: the tab's widgets move to the first remaining tab (below what it holds) or go with
 * it. A no-op on the last tab: that is deleting the group.
 */
export const withoutTab = (
	document: DashboardDocument,
	sectionId: string,
	tabId: string,
	action: "move" | "delete",
	nowIso: NowIso,
): DocumentFields => {
	const sections = document.sections ?? []
	const found = Arr.findFirst(sections, (candidate) => candidate.id === sectionId)
	if (Option.isNone(found)) return document
	const section = found.value
	if (section.tabs.length <= 1 || !Arr.some(section.tabs, (tab) => tab.id === tabId)) return document
	const remaining = Arr.filter(section.tabs, (tab) => tab.id !== tabId)
	const destination = remaining[0]
	if (destination === undefined) return document
	const isDoomed = (widget: Widget) => widget.sectionId === sectionId && widget.tabId === tabId
	const offsetBase = widgetsInContainer(document, { sectionId, tabId: destination.id })
	const offset =
		offsetBase.length === 0 ? 0 : Math.max(...Arr.map(offsetBase, (w) => w.layout.y + w.layout.h))
	const widgets =
		action === "delete"
			? Arr.filter(document.widgets, (widget) => !isDoomed(widget))
			: Arr.map(document.widgets, (widget) =>
					isDoomed(widget)
						? {
								...widget,
								tabId: destination.id,
								layout: { ...widget.layout, y: widget.layout.y + offset },
							}
						: widget,
				)
	return {
		...touch(
			document,
			Arr.map(sections, (candidate) =>
				candidate.id === sectionId
					? {
							...candidate,
							tabs: remaining,
							...(remaining.length === 1 ? { title: destination.title } : undefined),
						}
					: candidate,
			),
			nowIso,
		),
		widgets,
	}
}

/** `moveWidgetToSection`: rebased onto the destination's next free slot. */
export const withMovedWidget = (
	document: DashboardDocument,
	widgetId: string,
	target: SectionTarget,
	nowIso: NowIso,
): DocumentFields => {
	const found = Arr.findFirst(document.widgets, (candidate) => candidate.id === widgetId)
	if (Option.isNone(found)) return document
	const widget = found.value
	const position = findNextPosition(
		Arr.filter(widgetsInContainer(document, target), (w) => w.id !== widgetId),
		widget.layout.w,
	)
	const moved = withSectionTarget({ ...widget, layout: { ...widget.layout, ...position } }, target)
	return {
		...document,
		widgets: sortWidgetsForLayout(
			Arr.map(document.widgets, (candidate) => (candidate.id === widgetId ? moved : candidate)),
			document.sections ?? [],
		),
		updatedAt: nowIso,
	}
}
