import * as Policy from "@maple/domain/policy"
import {
	StatusPageComponentId,
	StatusPageId,
	StatusPageIncidentId,
	StatusPageVisibility,
} from "@maple/domain"
import {
	StatusPageConfig,
	V2StatusPage,
	V2StatusPageComponent,
	V2StatusPageCustomDomain,
	V2StatusPageIncident,
	V2UptimeMonitor,
} from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { StatusPageSearch } from "../../../route/search"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import {
	BrandingField,
	ComponentForm,
	IncidentEditForm,
	IncidentForm,
	SettingsForm,
	UpdateForm,
} from "../shared/form"
import { Picker } from "../shared/picker"
import { PreviewHistory, PreviewScheme, PreviewState, PreviewWidth } from "../shared/preview"

// `/status-pages/$pageId`: the live page, its incidents, its maintenance and its settings. A
// component opens in place under Settings > Monitors; an incident, or Add monitors, in a side sheet.

/** Where the Post incident dialog is: writing it, or reviewing what publishing it changes. */
export const ComposeStep = Schema.Literals(["write", "review"])
export type ComposeStep = typeof ComposeStep.Type

/**
 * The Post update dialog's form: being written, under review, posting, or showing why the post
 * failed. `Closed` until the dialog first opens; a closed dialog keeps its last form on screen
 * while it fades out.
 */
export const UpdateFormState = Schema.Union([
	Schema.TaggedStruct("Closed", {}),
	Schema.TaggedStruct("Writing", { form: UpdateForm }),
	Schema.TaggedStruct("Reviewing", { form: UpdateForm }),
	Schema.TaggedStruct("Posting", { form: UpdateForm }),
	Schema.TaggedStruct("Failed", { form: UpdateForm, failure: LoadFailure }),
])
export type UpdateFormState = typeof UpdateFormState.Type

export const JsonEdit = Schema.Struct({
	draft: Schema.String,
	/** The saved document the draft was opened from: its diff base and the version an apply sends. */
	base: StatusPageConfig,
	/** After a conflict: the next good config read becomes the base, keeping the typed draft. */
	isRebasing: Schema.Boolean,
})
export type JsonEdit = typeof JsonEdit.Type

export const BreakGlassAction = Schema.Literals(["rotate", "revoke"])
export type BreakGlassAction = typeof BreakGlassAction.Type

/** The part of the Access save in flight: the new password, the visibility, or a leftover password's removal. */
export const AccessAction = Schema.Literals(["visibility", "password", "removePassword"])
export type AccessAction = typeof AccessAction.Type

/** A freshly issued break-glass token: shown once, never read back. */
export const RevealedToken = Schema.Struct({ token: Schema.String, suffix: Schema.String })

/** What is open: one component (in its Monitors row), or an incident or Add monitors (in the sheet). */
export const Panel = Schema.Union([
	Schema.TaggedStruct("Component", { componentId: StatusPageComponentId }),
	Schema.TaggedStruct("Incident", { incidentId: StatusPageIncidentId }),
	/** `session` tells this opening of Add from earlier ones whose writes are still in flight. */
	Schema.TaggedStruct("Add", { session: Schema.Number }),
])
export type Panel = typeof Panel.Type

/**
 * The last component save, for the component it belongs to: in flight (with the form it sends),
 * landed, or refused with why. Its row shows it; another component's row shows nothing of it.
 */
export const ComponentSave = Schema.Union([
	Schema.TaggedStruct("Saving", { componentId: StatusPageComponentId, form: ComponentForm }),
	Schema.TaggedStruct("Saved", { componentId: StatusPageComponentId }),
	Schema.TaggedStruct("Failed", { componentId: StatusPageComponentId, failure: LoadFailure }),
])
export type ComponentSave = typeof ComponentSave.Type

/** What leaving a component with unsaved edits does once they are discarded. */
export const ComponentLeave = Schema.Union([
	Schema.TaggedStruct("Open", { componentId: StatusPageComponentId, isRevealed: Schema.Boolean }),
	Schema.TaggedStruct("Close", {}),
	Schema.TaggedStruct("Add", {}),
])
export type ComponentLeave = typeof ComponentLeave.Type

/** A leave waiting on the discard confirm, and the component whose edits it drops. */
export const PendingLeave = Schema.Struct({ componentId: StatusPageComponentId, action: ComponentLeave })

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
	grants: Schema.Array(Policy.PermissionName),
	isSessionLoaded: Schema.Boolean,
	pageMenu: Menu.Model,
	panel: Schema.NullOr(Panel),
	/**
	 * A component opened from the page preview, whose row scrolls into view as it opens; one
	 * expanded in the list stays where it was clicked.
	 */
	revealComponentId: Schema.NullOr(StatusPageComponentId),
	/** The field a header or footer click in the preview asked for, revealed once its section opens. */
	revealFieldId: Schema.NullOr(Schema.String),
	/** The side sheet an incident or Add monitors opens in; open while `panel` is one of those. */
	panelSheet: Dialog.Model,
	/** What the sheet shows: the last incident or Add `panel` held, kept while the sheet closes. */
	sheetPanel: Schema.NullOr(Panel),
	/** The incident the sheet last showed, so a closing sheet keeps it after a delete. */
	sheetIncident: Schema.NullOr(V2StatusPageIncident),
	// Preview
	previewScheme: PreviewScheme,
	/** Looking only, like the scheme: neither is saved with the page. */
	previewWidth: PreviewWidth,
	previewState: PreviewState,
	previewGeneration: Schema.Number,
	previewShown: Schema.Number,
	previewHistory: PreviewHistory,
	// Components
	/**
	 * The open component as its inputs hold it; Save sends it. Unsaved edits outlive a tab switch,
	 * and Monitors opens on them again.
	 */
	componentForm: ComponentForm,
	componentSave: Schema.NullOr(ComponentSave),
	/** The open component's Group dropdown: the page's groups, "No group" and a typed new one. */
	groupPicker: Combobox.Model,
	/** The leave waiting on the discard confirm; kept while the dialog fades out, so its title holds. */
	pendingLeave: Schema.NullOr(PendingLeave),
	discardComponentDialog: Dialog.Model,
	confirmDeleteComponentId: Schema.NullOr(StatusPageComponentId),
	deleteComponentDialog: Dialog.Model,
	isDeletingComponent: Schema.Boolean,
	/**
	 * Every component's id in the order a drag or arrow key left them, waiting on Save with the open
	 * component's edits; `null` while the list shows the saved order. Leaving Monitors keeps it.
	 */
	pendingOrder: Schema.NullOr(Schema.Array(StatusPageComponentId)),
	isSavingOrder: Schema.Boolean,
	/** Why the last order save was refused; the order stays pending. */
	orderFailure: Schema.NullOr(LoadFailure),
	addPicker: Picker,
	isAddingComponents: Schema.Boolean,
	/** The last Add session opened; each opening takes the next number. */
	addSession: Schema.Number,
	// Incidents
	composeDialog: Dialog.Model,
	composeStep: ComposeStep,
	incidentForm: IncidentForm,
	isCreatingIncident: Schema.Boolean,
	incidentFailure: Schema.NullOr(LoadFailure),
	updateDialog: Dialog.Model,
	updateForm: UpdateFormState,
	publishingIncidentIds: Schema.Array(StatusPageIncidentId),
	editIncidentDialog: Dialog.Model,
	/** The incident whose title, impact and components are edited; `null` until the dialog first opens. */
	incidentEdit: Schema.NullOr(IncidentEditForm),
	isSavingIncident: Schema.Boolean,
	incidentEditFailure: Schema.NullOr(LoadFailure),
	confirmDeleteIncidentId: Schema.NullOr(StatusPageIncidentId),
	deleteIncidentDialog: Dialog.Model,
	isDeletingIncident: Schema.Boolean,
	// Live
	/** The status Worker's origin; empty hides the public links (no status domain yet). */
	publicBaseUrl: Schema.String,
	/** `statusPageOrgKey` of the org, none until computed: the address is `/s/<org key>/<slug>`. */
	orgKey: Schema.Option(Schema.String),
	urlCopy: CopyButton.Model,
	// Settings
	/** Edits over the saved page; `null` while the form shows the page as saved. */
	settingsEdits: Schema.NullOr(SettingsForm),
	/** The logo or favicon drop target a file is dragged over. */
	brandingDrag: Schema.NullOr(BrandingField),
	/** The upload-or-link dialog, the image it changes and its link as typed. */
	brandingDialog: Dialog.Model,
	brandingDialogField: BrandingField,
	brandingLink: Schema.String,
	/** Bumped by each upload, link, removal and discard: a file read that finishes later is dropped. */
	brandingRead: Schema.Number,
	isSavingSettings: Schema.Boolean,
	/** Basic settings' Save: Who can view saves once the fields have, so neither reply overwrites the other's page. */
	savesAccessNext: Schema.Boolean,
	settingsFailure: Schema.NullOr(LoadFailure),
	/** The address the last save was refused for, another page having it; shown on the field while it is typed. */
	takenSlug: Schema.NullOr(Schema.String),
	isPublishing: Schema.Boolean,
	breakGlassDialog: Dialog.Model,
	breakGlassAction: Schema.NullOr(BreakGlassAction),
	isChangingBreakGlass: Schema.Boolean,
	revealedToken: Schema.NullOr(RevealedToken),
	tokenCopy: CopyButton.Model,
	deletePageDialog: Dialog.Model,
	isDeletingPage: Schema.Boolean,
	// Access
	accessAction: Schema.NullOr(AccessAction),
	/** Who can view as picked; `null` while it is the page's. */
	visibilityDraft: Schema.NullOr(StatusPageVisibility),
	/** The new page password as typed; empty for none. */
	passwordDraft: Schema.String,
	accessFailure: Schema.NullOr(LoadFailure),
	// Custom domain
	/** The page's custom domain and whether this deployment offers them; read with the page. */
	customDomain: KeyedSchema(V2StatusPageCustomDomain, LoadFailure),
	/** The hostname as typed; `null` while the field shows the saved one. */
	customDomainDraft: Schema.NullOr(Schema.String),
	customDomainAction: Schema.NullOr(Schema.Literals(["set", "check", "remove"])),
	customDomainFailure: Schema.NullOr(LoadFailure),
	removeCustomDomainDialog: Dialog.Model,
	dnsCopy: CopyButton.Model,
	/** Which DNS value `dnsCopy` reports on. */
	dnsCopyKey: Schema.NullOr(Schema.String),
	// JSON
	/** The page as `GET …/config` returns it: every component, and the revision to apply against. */
	config: KeyedSchema(StatusPageConfig, LoadFailure),
	/** The open JSON edit; `null` while the tab shows the page as saved. */
	jsonEdit: Schema.NullOr(JsonEdit),
	isApplyingJson: Schema.Boolean,
	jsonFailure: Schema.NullOr(LoadFailure),
	jsonCopy: CopyButton.Model,
})
export type Model = typeof Model.Type

/** The viewer may change what this page edits (`status_pages:edit`). */
export const canManage = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "status_pages:edit")

/** The viewer may post, update, edit and delete incidents and maintenance (`status_page_incidents:post`). */
export const canPostIncidents = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "status_page_incidents:post")

/** The viewer may change who can read the page, its password included (`status_pages:access`). */
export const canChangeAccess = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "status_pages:access")

/** The viewer may rotate or revoke the break-glass token (`status_pages:break_glass`). */
export const canBreakGlass = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "status_pages:break_glass")
