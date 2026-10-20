import { Schema } from "effect"
import { DashboardsSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import * as TagEditor from "../kit/tag-editor"
import * as Menu from "../../../ui/menu"
import * as Combobox from "../../../ui/combobox"

// The dashboards list.

/** `dashboardGlyph`: what the row's icon says the dashboard reads. */
export const Glyph = Schema.Literals([
	"GridIcon",
	"PulseIcon",
	"TextWrapIcon",
	"CircleWarningIcon",
	"ChartBarIcon",
	"CodeIcon",
	"FileIcon",
])
export type Glyph = typeof Glyph.Type

/** One decoded dashboard, reduced to what a row, the filters and the header readout read. */
export const ListDashboard = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	tags: Schema.Array(Schema.String),
	widgetCount: Schema.Number,
	readsShort: Schema.String,
	readsFull: Schema.String,
	glyph: Glyph,
	createdAt: Schema.String,
	updatedAt: Schema.String,
})
export type ListDashboard = typeof ListDashboard.Type

/** `useDashboardsFallback`: the HTTP snapshot read while live sync is down. */
export const Fallback = Schema.Union([
	Schema.TaggedStruct("Idle", {}),
	Schema.TaggedStruct("Loading", {}),
	Schema.TaggedStruct("Ready", { dashboards: Schema.Array(ListDashboard) }),
	Schema.TaggedStruct("Failed", {}),
])
export type Fallback = typeof Fallback.Type

export const Scope = Schema.Literals(["all", "favorites"])
export type Scope = typeof Scope.Type

export const Model = Schema.Struct({
	search: DashboardsSearch,
	/** `null` until the collection is ready (`DashboardsListModel`'s `loading`). */
	dashboards: Schema.NullOr(Schema.Array(ListDashboard)),
	nowMs: Schema.NullOr(Schema.Number),
	/** `toLocaleString`'s locale for the header counts and dates. */
	locale: Schema.String,
	/** `useDashboardPreferences`: localStorage favorites and the stored default sort. */
	favorites: Schema.Array(Schema.String),
	storedSort: Schema.String,
	isPrefsLoaded: Schema.Boolean,
	/** `ToolbarSearch`'s input and its debounce generation. */
	searchDraft: Schema.String,
	searchGeneration: Schema.Number,
	sortMenu: Menu.Model,
	/** The row whose kebab menu `rowMenu` is; other rows render a closed one. */
	rowMenuId: Schema.NullOr(Schema.String),
	rowMenu: Menu.Model,
	pendingDelete: Schema.NullOr(ListDashboard),
	deleteDialog: Dialog.Model,
	pendingTags: Schema.NullOr(ListDashboard),
	tagEditor: TagEditor.Model,
	/** `TagFilterMenu`: the multi-select tag combobox; its selection is the URL's `tags`. */
	tagFilter: Combobox.Model,
	/** `persistenceErrorAtom`: a failed write turns the list read-only with this reason. */
	persistenceError: Schema.NullOr(Schema.String),
	isCreating: Schema.Boolean,
	/** The live list never answered within `COLLECTION_LOAD_TIMEOUT_MS`: the HTTP snapshot's state. */
	fallback: Fallback,
})
export type Model = typeof Model.Type
