import {
	DASHBOARD_MAX_SECTIONS,
	DASHBOARD_MAX_TABS_PER_SECTION,
	type DashboardSection,
	type DashboardSectionTab,
} from "./shared/sections"
import { Array as Arr } from "effect"

// Pure helpers for dashboard sections. No Effect runtime and no I/O, so the API
// write path, the web read path and the tests all share one implementation of
// the invariants.
//
// The shape is deliberately a sidecar: `sections` sits beside a still-flat
// `widgets` array, and membership is two optional ids on the widget. Nesting
// widgets inside sections would have broken the public v2 `widgets` field, every
// MCP tool that operates on `ReadonlyArray<DashboardWidget>`, all the templates,
// the Perses importer and the IaC passthrough — in exchange for an invariant
// `sanitizeDashboardSections` gives us anyway.

/** Stable address of the grid a widget lives in. `null` is the root canvas. */
export type SectionTarget = { readonly sectionId: string; readonly tabId: string } | null

/**
 * The minimum a widget must expose to be placed. Both the domain
 * `DashboardWidget` and the web's structurally-identical view type satisfy it,
 * so these helpers serve both without either package importing the other.
 */
export interface SectionMembership {
	sectionId?: string | undefined
	tabId?: string | undefined
}

interface SectionedDocument<W extends SectionMembership> {
	readonly widgets: ReadonlyArray<W>
	readonly sections?: ReadonlyArray<DashboardSection> | undefined
}

/** Key identifying a widget's container. Every root widget shares one key. */
export const ROOT_CONTAINER_KEY = "__root__"

export const containerKeyFor = (target: SectionTarget): string =>
	target === null ? ROOT_CONTAINER_KEY : `${target.sectionId}\0${target.tabId}`

export const containerKeyOf = (widget: SectionMembership): string =>
	widget.sectionId === undefined || widget.tabId === undefined
		? ROOT_CONTAINER_KEY
		: containerKeyFor({ sectionId: widget.sectionId, tabId: widget.tabId })

/**
 * Bucket widgets by container, preserving document order within each bucket.
 *
 * Every container declared by `sections` gets an entry even when empty, so the
 * renderer shows an empty group rather than silently omitting it.
 */
export function groupWidgetsByContainer<W extends SectionMembership>(
	doc: SectionedDocument<W>,
): ReadonlyMap<string, ReadonlyArray<W>> {
	const buckets = new Map<string, Array<W>>()
	buckets.set(ROOT_CONTAINER_KEY, [])
	for (const section of doc.sections ?? []) {
		for (const tab of section.tabs) {
			buckets.set(containerKeyFor({ sectionId: section.id, tabId: tab.id }), [])
		}
	}

	for (const widget of doc.widgets) {
		// A widget addressing a container that no longer exists renders at the
		// root. Storage is repaired on write; this keeps a stale in-memory
		// document from dropping tiles on the floor in the meantime.
		const bucket = buckets.get(containerKeyOf(widget)) ?? buckets.get(ROOT_CONTAINER_KEY)
		bucket?.push(widget)
	}

	return buckets
}

export function rootWidgets<W extends SectionMembership>(doc: SectionedDocument<W>): ReadonlyArray<W> {
	return groupWidgetsByContainer(doc).get(ROOT_CONTAINER_KEY) ?? []
}

export function widgetsInTab<W extends SectionMembership>(
	doc: SectionedDocument<W>,
	sectionId: string,
	tabId: string,
): ReadonlyArray<W> {
	return groupWidgetsByContainer(doc).get(containerKeyFor({ sectionId, tabId })) ?? []
}

/**
 * Re-address a widget, returning a fresh object.
 *
 * `sectionId`/`tabId` are `Schema.optionalKey`, so "ungrouped" has to mean the
 * keys are *absent* — a present `undefined` fails the document encode. Copy then
 * `delete` rather than destructuring: `Omit<W, …>` is not assignable back to a
 * generic `W`, and the only way to express that is a cast.
 */
export function withSectionTarget<W extends SectionMembership>(widget: W, target: SectionTarget): W {
	const next = { ...widget }
	if (target === null) {
		delete next.sectionId
		delete next.tabId
		return next
	}
	next.sectionId = target.sectionId
	next.tabId = target.tabId
	return next
}

const dedupeById = <T extends { readonly id: string }>(items: ReadonlyArray<T>): ReadonlyArray<T> => {
	const seen = new Set<string>()
	const out: Array<T> = []
	for (const item of items) {
		if (seen.has(item.id)) continue
		seen.add(item.id)
		out.push(item)
	}
	return out
}

function sanitizeSection(section: DashboardSection): DashboardSection {
	const deduped = dedupeById(section.tabs)
	const capped =
		deduped.length > DASHBOARD_MAX_TABS_PER_SECTION
			? deduped.slice(0, DASHBOARD_MAX_TABS_PER_SECTION)
			: deduped
	// A section with no tabs is unrenderable, so synthesise one named after the
	// section. This is the only place the "always >= 1 tab" invariant is created.
	const tabs: ReadonlyArray<DashboardSectionTab> =
		capped.length > 0 ? capped : [{ id: section.id, title: section.title }]

	const tabsUnchanged =
		tabs.length === section.tabs.length && Arr.every(tabs, (tab, i) => tab === section.tabs[i])
	// "Collapsed by default" and "can never be collapsed" contradict each other,
	// and the document loses either way: the group renders folded with no chevron
	// to unfold it. `collapsible: false` wins, because it is the stronger claim.
	const contradictory = section.collapsible === false && section.collapsed === true

	if (tabsUnchanged && !contradictory) return section
	const next = { ...section, ...(!tabsUnchanged ? { tabs } : undefined) }
	if (contradictory) delete (next satisfies { collapsed?: boolean }).collapsed
	return next
}

/**
 * Repair a document to the section invariants.
 *
 * Idempotent, and returns the input **by reference** when there is nothing to
 * repair — so every pre-sections document is a strict no-op and the write path
 * can call this unconditionally.
 *
 * - de-dupes section and tab ids (first writer wins), caps sections and tabs
 * - synthesises a tab for a section that has none
 * - clears `sectionId`/`tabId` on a widget pointing at a section that is gone
 * - reassigns a widget's `tabId` to the section's first tab when it dangles
 *
 * Deliberately repairs rather than rejects: a widget orphaned by a concurrent
 * section delete must not fail the whole dashboard decode. That is also why the
 * invariants live here instead of in schema `check`s.
 */
export function sanitizeDashboardSections<W extends SectionMembership, D extends SectionedDocument<W>>(
	doc: D,
): D {
	if (doc.sections === undefined) return doc

	const deduped = dedupeById(doc.sections)
	const capped =
		deduped.length > DASHBOARD_MAX_SECTIONS ? deduped.slice(0, DASHBOARD_MAX_SECTIONS) : deduped
	const sections = Arr.map(capped, sanitizeSection)

	const tabsBySection = new Map<string, { readonly ids: ReadonlySet<string>; readonly first: string }>()
	for (const section of sections) {
		tabsBySection.set(section.id, {
			ids: new Set(Arr.map(section.tabs, (tab) => tab.id)),
			// `sanitizeSection` guarantees at least one tab.
			first: section.tabs[0]?.id ?? section.id,
		})
	}

	let widgetsChanged = false
	const widgets = Arr.map(doc.widgets, (widget) => {
		if (widget.sectionId === undefined) {
			// A `tabId` with no `sectionId` addresses nothing.
			if (widget.tabId === undefined) return widget
			widgetsChanged = true
			return withSectionTarget(widget, null)
		}

		const tabs = tabsBySection.get(widget.sectionId)
		if (tabs === undefined) {
			widgetsChanged = true
			return withSectionTarget(widget, null)
		}

		if (widget.tabId !== undefined && tabs.ids.has(widget.tabId)) return widget
		widgetsChanged = true
		return withSectionTarget(widget, { sectionId: widget.sectionId, tabId: tabs.first })
	})

	const sectionsChanged =
		sections.length !== doc.sections.length ||
		Arr.some(sections, (section, index) => section !== doc.sections?.[index])

	if (!sectionsChanged && !widgetsChanged) return doc
	return {
		...doc,
		...(sectionsChanged ? { sections } : undefined),
		...(widgetsChanged ? { widgets } : undefined),
	}
}
