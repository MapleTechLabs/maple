import { Schema } from "effect"
import { File } from "foldkit/file"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "@maple/views/ui/dialog"
import * as TagEditor from "../kit/tag-editor"
import * as Menu from "@maple/views/ui/menu"
import * as Combobox from "@maple/views/ui/combobox"
import { ListDashboard, Scope } from "./model"
import { WriteSync } from "../kit/store"

/** A created dashboard: its id to open and its name for the toast. */
const Created = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	isPerses: Schema.Boolean,
	/** A Perses import's conversion warnings (unsupported or changed panels). */
	warnings: Schema.Array(Schema.String),
})

/** A failed write: the message `getErrorMessage` would show, and whether the API refused this one write. */
export const WriteFailure = Schema.Struct({ message: Schema.String, isRejected: Schema.Boolean })
export type WriteFailure = typeof WriteFailure.Type

const WriteResult = Schema.Result(WriteSync, WriteFailure)

export const Message = defineMessageUnion({
	/** The clock and the browser's locale, read together before the list renders. */
	CompletedReadClock: { nowMs: Schema.Number, locale: Schema.String },
	CompletedLoadPreferences: { favorites: Schema.Array(Schema.String), sort: Schema.String },
	UpdatedDashboards: { orgId: Schema.String, dashboards: Schema.Array(ListDashboard) },
	/** The live list sat loading past the timeout (`useCollectionLoadFailed`). */
	TimedOutLiveDashboards: { orgId: Schema.String },
	CompletedFetchFallback: {
		orgId: Schema.String,
		result: Schema.Result(Schema.Array(ListDashboard), Schema.String),
	},
	ClickedRetrySync: {},
	ChangedSearchDraft: { value: Schema.String },
	ElapsedSearchDebounce: { generation: Schema.Number },
	ChangedScope: { scope: Scope },
	ClickedClearSearch: {},
	ClickedShowAllTags: {},
	ClickedBrowseTemplates: {},
	ClickedCreate: {},
	CompletedCreateDashboard: { result: Schema.Result(Schema.String, WriteFailure) },
	ClickedImport: {},
	CompletedOpenImportPicker: {},
	ChoseImportFile: { files: Schema.Array(File) },
	CompletedImportDashboard: { result: Schema.Result(Created, Schema.String) },
	ToggledFavorite: { id: Schema.String },
	CompletedSavePreferences: {},
	GotSortMenuMessage: { message: Menu.Message },
	GotRowMenuMessage: { rowId: Schema.String, message: Menu.Message },
	CompletedExportDashboard: { error: Schema.NullOr(Schema.String) },
	CompletedDuplicateDashboard: { result: Schema.Result(Created, WriteFailure) },
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedConfirmDelete: {},
	CompletedDeleteDashboard: { result: WriteResult },
	GotTagEditorMessage: { message: TagEditor.Message },
	CompletedSaveTags: { result: WriteResult },
	GotTagFilterMessage: { message: Combobox.Message },
	CompletedFocusTagSearch: {},
})
export type Message = typeof Message.Type
