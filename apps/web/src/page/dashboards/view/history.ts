import { DashboardDocument, DashboardVersionChangeKind } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import { Schema } from "effect"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"

// Version history: the panel's timeline, the previewed version and
// its snapshot, read through `dashboards.listVersions` / `retrieveVersion`.

export const VersionRow = Schema.Struct({
	id: Schema.String,
	versionNumber: Schema.Number,
	changeKind: DashboardVersionChangeKind,
	changeSummary: Schema.NullOr(Schema.String),
	isRestore: Schema.Boolean,
	createdAt: Schema.String,
	createdBy: Schema.String,
})
export type VersionRow = typeof VersionRow.Type

export const VersionsData = AsyncData.Schema(Schema.Array(VersionRow), LoadFailure)
export type VersionsData = typeof VersionsData.schema.Type

export const SnapshotData = AsyncData.Schema(DashboardDocument, LoadFailure)
export type SnapshotData = typeof SnapshotData.schema.Type

export const KIND_LABEL = {
	created: "Created",
	renamed: "Renamed",
	description_changed: "Description",
	tags_changed: "Tags",
	time_range_changed: "Time range",
	variables_changed: "Variables",
	refresh_interval_changed: "Auto-refresh",
	widget_added: "Widget added",
	widget_removed: "Widget removed",
	widget_updated: "Widget updated",
	layout_changed: "Layout",
	section_added: "Group added",
	section_removed: "Group removed",
	section_updated: "Groups",
	restored: "Restored",
	multiple: "Edited",
} satisfies Record<DashboardVersionChangeKind, string>

/** The marker colour per change, from the chart and severity tokens. */
export const KIND_DOT = {
	created: "bg-primary",
	renamed: "bg-chart-1",
	description_changed: "bg-chart-1",
	tags_changed: "bg-chart-1",
	time_range_changed: "bg-chart-2",
	variables_changed: "bg-chart-2",
	refresh_interval_changed: "bg-chart-2",
	widget_added: "bg-chart-3",
	widget_removed: "bg-severity-warn",
	widget_updated: "bg-chart-4",
	layout_changed: "bg-muted-foreground",
	section_added: "bg-chart-3",
	section_removed: "bg-severity-warn",
	section_updated: "bg-muted-foreground",
	restored: "bg-primary ring-[3px] ring-primary-a3",
	multiple: "bg-chart-5",
} satisfies Record<DashboardVersionChangeKind, string>

export const HistoryState = Schema.Struct({
	isOpen: Schema.Boolean,
	versions: VersionsData.schema,
	/**
	 * Bumped per version-list read, so an older list landing last is dropped. A counter, not a
	 * `Keyed` slot: the read has no org-scoped request key and reopening resets to `Loading`.
	 */
	versionsGeneration: Schema.Number,
	previewed: Schema.NullOr(VersionRow),
	snapshot: SnapshotData.schema,
	restoreDialog: Dialog.Model,
	isRestoring: Schema.Boolean,
	/** `PreviewedCanvas`'s local section state: browsing a preview's groups never touches the URL. */
	sectionView: Schema.Struct({
		collapsed: Schema.optionalKey(Schema.String),
		expanded: Schema.optionalKey(Schema.String),
		tab: Schema.optionalKey(Schema.String),
	}),
})
export type HistoryState = typeof HistoryState.Type

export const initHistory = (): HistoryState => ({
	isOpen: false,
	versions: AsyncData.Idle(),
	versionsGeneration: 0,
	previewed: null,
	snapshot: AsyncData.Idle(),
	restoreDialog: Dialog.init("dashboard-restore-version", "alert-dialog"),
	isRestoring: false,
	sectionView: {},
})

/** `actorInitials`: the first two alphanumerics of the opaque user id. */
export const actorInitials = (userId: string): string => {
	const upper = userId.trim().toUpperCase()
	if (upper === "") return "?"
	const chars = upper.replace(/[^A-Z0-9]/g, "")
	return chars.slice(0, 2) || upper.slice(0, 2)
}
