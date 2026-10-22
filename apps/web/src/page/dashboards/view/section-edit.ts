import type { DashboardDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import {
	withAddedSection,
	withAddedTab,
	withMovedWidget,
	withoutSection,
	withoutTab,
	withRenamedSection,
	withRenamedTab,
	withReorderedSections,
	withSectionCollapsedDefault,
	withSectionCollapsible,
} from "../kit/sections"
import type { DocumentFields } from "../kit/store"

// The section and tab writes of `DashboardActionsProvider`, as data: a Command carries one and
// applies it to the current document. New ids are minted by the Command (`generateId`).

const Target = Schema.NullOr(Schema.Struct({ sectionId: Schema.String, tabId: Schema.String }))

export const SectionEdit = defineTaggedUnion({
	AddSection: {},
	RenameSection: { sectionId: Schema.String, title: Schema.String },
	SetCollapsedDefault: { sectionId: Schema.String, collapsed: Schema.Boolean },
	SetCollapsible: { sectionId: Schema.String, collapsible: Schema.Boolean },
	ReorderSections: { fromIndex: Schema.Number, toIndex: Schema.Number },
	DeleteSection: { sectionId: Schema.String, action: Schema.Literals(["ungroup", "delete"]) },
	AddTab: { sectionId: Schema.String },
	RenameTab: { sectionId: Schema.String, tabId: Schema.String, title: Schema.String },
	DeleteTab: {
		sectionId: Schema.String,
		tabId: Schema.String,
		action: Schema.Literals(["move", "delete"]),
	},
	MoveWidget: { widgetId: Schema.String, target: Target },
})
export type SectionEdit = typeof SectionEdit.Type

/** Applies an edit; `nextId` mints the ids a new group or tab needs, in a fixed call order. */
export const applySectionEdit = (
	edit: SectionEdit,
	document: DashboardDocument,
	nowIso: DashboardDocument["updatedAt"],
	nextId: () => string,
): DocumentFields =>
	SectionEdit.match(edit, {
		AddSection: () => withAddedSection(document, { sectionId: nextId(), tabId: nextId() }, nowIso),
		RenameSection: ({ sectionId, title }) => withRenamedSection(document, sectionId, title, nowIso),
		SetCollapsedDefault: ({ sectionId, collapsed }) =>
			withSectionCollapsedDefault(document, sectionId, collapsed, nowIso),
		SetCollapsible: ({ sectionId, collapsible }) =>
			withSectionCollapsible(document, sectionId, collapsible, nowIso),
		ReorderSections: ({ fromIndex, toIndex }) =>
			withReorderedSections(document, fromIndex, toIndex, nowIso),
		DeleteSection: ({ sectionId, action }) => withoutSection(document, sectionId, action, nowIso),
		AddTab: ({ sectionId }) => withAddedTab(document, sectionId, nextId(), nowIso),
		RenameTab: ({ sectionId, tabId, title }) => withRenamedTab(document, sectionId, tabId, title, nowIso),
		DeleteTab: ({ sectionId, tabId, action }) => withoutTab(document, sectionId, tabId, action, nowIso),
		MoveWidget: ({ widgetId, target }) => withMovedWidget(document, widgetId, target, nowIso),
	})
