import { Schema } from "effect"
import { File } from "foldkit/file"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "../../../ui/dialog"
import * as TagEditor from "../kit/tag-editor"
import * as Menu from "../../../ui/menu"
import { ListDashboard, Scope } from "./model"

/** A created dashboard: its id to open and its name for the toast. */
const Created = Schema.Struct({ id: Schema.String, name: Schema.String, isPerses: Schema.Boolean })

/** A write's outcome: the failure is the message `getErrorMessage` would show. */
const WriteResult = Schema.Result(Schema.Void, Schema.String)

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	CompletedLoadPreferences: { favorites: Schema.Array(Schema.String), sort: Schema.String },
	UpdatedDashboards: { orgId: Schema.String, dashboards: Schema.Array(ListDashboard) },
	ChangedSearchDraft: { value: Schema.String },
	ElapsedSearchDebounce: { generation: Schema.Number },
	ChangedScope: { scope: Scope },
	ClickedClearSearch: {},
	ClickedShowAllTags: {},
	ClickedBrowseTemplates: {},
	ClickedCreate: {},
	CompletedCreateDashboard: { result: Schema.Result(Schema.String, Schema.String) },
	ClickedImport: {},
	CompletedOpenImportPicker: {},
	ChoseImportFile: { files: Schema.Array(File) },
	CompletedImportDashboard: { result: Schema.Result(Created, Schema.String) },
	ToggledFavorite: { id: Schema.String },
	CompletedSavePreferences: {},
	GotSortMenuMessage: { message: Menu.Message },
	GotRowMenuMessage: { rowId: Schema.String, message: Menu.Message },
	CompletedExportDashboard: {},
	CompletedDuplicateDashboard: { result: Schema.Result(Created, Schema.String) },
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedConfirmDelete: {},
	CompletedDeleteDashboard: { result: WriteResult },
	GotTagEditorMessage: { message: TagEditor.Message },
	CompletedSaveTags: { result: WriteResult },
})
export type Message = typeof Message.Type
