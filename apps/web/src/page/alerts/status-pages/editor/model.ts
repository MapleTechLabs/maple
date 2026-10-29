import { StatusPageComponentId, StatusPageId, StatusPageIncidentId } from "@maple/domain"
import {
	StatusPageConfig,
	V2StatusPage,
	V2StatusPageComponent,
	V2StatusPageIncident,
	V2UptimeMonitor,
} from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { AlertsStatusPageSearch } from "../../../../route/search"
import * as CopyButton from "../../../../ui/copy-button"
import * as Dialog from "../../../../ui/dialog"
import { ComponentForm, IncidentForm, SettingsForm, UpdateForm } from "./form"

// `/alerts/status-pages/$pageId`: one status page, its components, incidents and settings.

export const BreakGlassAction = Schema.Literals(["rotate", "revoke"])
export type BreakGlassAction = typeof BreakGlassAction.Type

/** The scheme the preview shows an Auto page in; the page itself follows each visitor. */
export const PreviewScheme = Schema.Literals(["light", "dark"])
export type PreviewScheme = typeof PreviewScheme.Type

/** A freshly issued break-glass token: shown once, never read back. */
export const RevealedToken = Schema.Struct({ token: Schema.String, suffix: Schema.String })

export const Model = Schema.Struct({
	search: AlertsStatusPageSearch,
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
	// Components
	componentDialog: Dialog.Model,
	componentForm: ComponentForm,
	isSavingComponent: Schema.Boolean,
	componentFailure: Schema.NullOr(LoadFailure),
	confirmDeleteComponentId: Schema.NullOr(StatusPageComponentId),
	deleteComponentDialog: Dialog.Model,
	isDeletingComponent: Schema.Boolean,
	isReordering: Schema.Boolean,
	// Incidents
	incidentDialog: Dialog.Model,
	incidentForm: IncidentForm,
	isCreatingIncident: Schema.Boolean,
	incidentFailure: Schema.NullOr(LoadFailure),
	updateDialog: Dialog.Model,
	updateForm: Schema.NullOr(UpdateForm),
	isPostingUpdate: Schema.Boolean,
	updateFailure: Schema.NullOr(LoadFailure),
	publishingIncidentIds: Schema.Array(StatusPageIncidentId),
	// Settings
	/** Edits over the saved page; `null` while the form shows the page as saved. */
	settingsEdits: Schema.NullOr(SettingsForm),
	isSavingSettings: Schema.Boolean,
	settingsFailure: Schema.NullOr(LoadFailure),
	previewScheme: PreviewScheme,
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
	isApplyingJson: Schema.Boolean,
	jsonFailure: Schema.NullOr(LoadFailure),
	jsonCopy: CopyButton.Model,
})
export type Model = typeof Model.Type
