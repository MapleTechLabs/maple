import { StatusPageComponentId, StatusPageId, StatusPageIncidentId } from "@maple/domain"
import {
	StatusPageConfig,
	V2StatusPage,
	V2StatusPageComponent,
	V2StatusPageIncident,
	V2UptimeMonitor,
} from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { StatusPageSearch } from "../../../route/search"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { ComponentForm, IncidentForm, SettingsForm, UpdateForm } from "../shared/form"
import { Picker } from "../shared/picker"
import { PreviewHistory, PreviewScheme } from "../shared/preview"

// `/status-pages/$pageId`: the page itself is the editor. A component or incident picked in the
// preview or the list opens in the side panel; Settings and JSON are views of their own.

export const BreakGlassAction = Schema.Literals(["rotate", "revoke"])
export type BreakGlassAction = typeof BreakGlassAction.Type

/** A freshly issued break-glass token: shown once, never read back. */
export const RevealedToken = Schema.Struct({ token: Schema.String, suffix: Schema.String })

/** What the side panel shows: one component or incident, the incident composer, or Add component. */
export const Panel = Schema.Union([
	Schema.TaggedStruct("Component", { componentId: StatusPageComponentId }),
	Schema.TaggedStruct("Incident", { incidentId: StatusPageIncidentId }),
	Schema.TaggedStruct("Compose", {}),
	Schema.TaggedStruct("Add", {}),
])
export type Panel = typeof Panel.Type

/** The component panel's autosave: each commit is a PATCH, its outcome shown next to the title. */
export const SaveState = Schema.Literals(["idle", "saving", "saved", "failed"])
export type SaveState = typeof SaveState.Type

export const Model = Schema.Struct({
	search: StatusPageSearch,
	/** The URL segment as written; `pageId` is `null` when it is not a page id. */
	rawPageId: Schema.String,
	pageId: Schema.NullOr(StatusPageId),
	nowMs: Schema.NullOr(Schema.Number),
	page: KeyedSchema(V2StatusPage, LoadFailure),
	components: KeyedSchema(Schema.Array(V2StatusPageComponent), LoadFailure),
	/** Open and recent incidents and maintenance, newest first. */
	incidents: KeyedSchema(Schema.Array(V2StatusPageIncident), LoadFailure),
	/** The org's monitors: the component picker and each linked component's status. */
	monitors: KeyedSchema(Schema.Array(V2UptimeMonitor), LoadFailure),
	isAdmin: Schema.Boolean,
	isSessionLoaded: Schema.Boolean,
	pageMenu: Menu.Model,
	panel: Schema.NullOr(Panel),
	// Preview
	previewScheme: PreviewScheme,
	previewGeneration: Schema.Number,
	previewShown: Schema.Number,
	previewHistory: PreviewHistory,
	// Components
	/** The selected component as its inputs hold it; each commit saves what differs. */
	componentForm: ComponentForm,
	componentSave: SaveState,
	componentFailure: Schema.NullOr(LoadFailure),
	confirmDeleteComponentId: Schema.NullOr(StatusPageComponentId),
	deleteComponentDialog: Dialog.Model,
	isDeletingComponent: Schema.Boolean,
	isReordering: Schema.Boolean,
	addPicker: Picker,
	isAddingComponents: Schema.Boolean,
	addFailure: Schema.NullOr(LoadFailure),
	// Incidents
	incidentForm: IncidentForm,
	isCreatingIncident: Schema.Boolean,
	incidentFailure: Schema.NullOr(LoadFailure),
	updateForm: Schema.NullOr(UpdateForm),
	isPostingUpdate: Schema.Boolean,
	updateFailure: Schema.NullOr(LoadFailure),
	publishingIncidentIds: Schema.Array(StatusPageIncidentId),
	// Live
	urlCopy: CopyButton.Model,
	// Settings
	/** Edits over the saved page; `null` while the form shows the page as saved. */
	settingsEdits: Schema.NullOr(SettingsForm),
	isSavingSettings: Schema.Boolean,
	settingsFailure: Schema.NullOr(LoadFailure),
	isPublishing: Schema.Boolean,
	breakGlassDialog: Dialog.Model,
	breakGlassAction: Schema.NullOr(BreakGlassAction),
	isChangingBreakGlass: Schema.Boolean,
	revealedToken: Schema.NullOr(RevealedToken),
	tokenCopy: CopyButton.Model,
	deletePageDialog: Dialog.Model,
	isDeletingPage: Schema.Boolean,
	// JSON
	/** The page as `GET …/config` returns it: every component, and the revision to apply against. */
	config: KeyedSchema(StatusPageConfig, LoadFailure),
	/** The edited document; `null` while the tab shows the page as saved. */
	jsonDraft: Schema.NullOr(Schema.String),
	/** The saved document the draft was opened from: its diff base and the version an apply sends. */
	jsonBase: Schema.NullOr(StatusPageConfig),
	/** After a conflict: the next config read becomes the draft's base, keeping the typed draft. */
	isRebasingJson: Schema.Boolean,
	isApplyingJson: Schema.Boolean,
	jsonFailure: Schema.NullOr(LoadFailure),
	jsonCopy: CopyButton.Model,
})
export type Model = typeof Model.Type
