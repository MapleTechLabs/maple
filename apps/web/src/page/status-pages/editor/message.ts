import {
	StatusPageComponentId,
	StatusPageIncidentId,
	StatusPageIncidentKind,
	StatusPageVisibility,
} from "@maple/domain"
import {
	StatusPageConfig,
	StatusPagePreviewParams,
	V2StatusPage,
	V2StatusPageBreakGlassToken,
	V2StatusPageComponent,
	V2StatusPageCustomDomain,
	V2StatusPageIncident,
	V2StatusPagePublishResult,
	V2UptimeMonitor,
} from "@maple/domain/http/v2"
import {
	StatusPageThemeAppearance,
	StatusPageThemeFont,
	StatusPageThemePreset,
	StatusPagePublicSnapshot,
	StatusPageThemeRadius,
} from "@maple/domain/status-page"
import { Schema } from "effect"
import type { File } from "foldkit/file"
import { defineMessageUnion } from "foldkit/message"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import {
	BrandingField,
	ComponentTextField,
	IncidentEditField,
	IncidentTextField,
	SettingsTextField,
	ThemeColorField,
} from "../shared/form"
import { AccessAction } from "./model"
import { PickerMessage } from "../shared/picker"
import { PreviewScheme, PreviewSelection, PreviewState, PreviewWidth } from "../shared/preview"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

export const UpdateTextField = Schema.Literals(["status", "body", "endedAt"])

/** A picked or dropped file; foldkit's own `File` schema leaves its decoding services `unknown`. */
const PickedFile = Schema.declare((input: unknown): input is File => input instanceof globalThis.File)

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchPage: { key: Schema.String, result: LoadOutcome(V2StatusPage) },
	CompletedFetchComponents: {
		key: Schema.String,
		result: LoadOutcome(Schema.Array(V2StatusPageComponent)),
	},
	CompletedFetchIncidents: { key: Schema.String, result: LoadOutcome(Schema.Array(V2StatusPageIncident)) },
	CompletedFetchMonitors: { key: Schema.String, result: LoadOutcome(Schema.Array(V2UptimeMonitor)) },
	CompletedFetchSession: SessionGrants,
	ClickedRetry: {},
	GotPageMenuMessage: { message: Menu.Message },
	CompletedOpenPublicPage: {},
	CompletedFocus: {},
	// Preview and selection
	ElapsedPreviewDebounce: { generation: Schema.Number },
	CompletedFetchPreview: {
		generation: Schema.Number,
		draft: StatusPagePreviewParams,
		result: LoadOutcome(StatusPagePublicSnapshot),
	},
	ReceivedPreviewSelection: { kind: PreviewSelection.fields.kind, id: Schema.String },
	ClickedComponent: { componentId: StatusPageComponentId },
	ClickedIncident: { incidentId: StatusPageIncidentId },
	GotPanelSheetMessage: { message: Dialog.Message },
	PressedEscape: {},
	// Components
	ChangedComponentField: { field: ComponentTextField, value: Schema.String },
	ToggledComponentUptime: {},
	GotGroupPickerMessage: { message: Combobox.Message },
	/** The Monitors save bar: a moved order and the open component's edits, together. */
	ClickedSaveMonitors: {},
	ClickedDiscardMonitors: {},
	CompletedSaveComponent: { result: LoadOutcome(V2StatusPageComponent) },
	ClickedConfirmDiscardComponent: {},
	GotDiscardComponentDialogMessage: { message: Dialog.Message },
	/** A grip drag let go over `index`, the slot within the component's group; the order waits on Save. */
	DroppedComponent: { componentId: StatusPageComponentId, index: Schema.Number },
	/** A group's grip let go over `index` among the groups (`null` is "No group"); waits on Save. */
	DroppedGroup: { group: Schema.NullOr(Schema.String), index: Schema.Number },
	/** ArrowUp (-1) or ArrowDown (1) on a group's grip. */
	PressedMoveGroup: { group: Schema.NullOr(Schema.String), offset: Schema.Number },
	/** ArrowUp (-1) or ArrowDown (1) on a component's grip. */
	PressedMoveComponent: { componentId: StatusPageComponentId, offset: Schema.Number },
	CompletedReorder: { result: LoadOutcome(Schema.Array(V2StatusPageComponent)) },
	ClickedDeleteComponent: { componentId: StatusPageComponentId },
	ClickedConfirmDeleteComponent: {},
	CompletedDeleteComponent: { result: LoadOutcome(Schema.Void) },
	GotDeleteComponentDialogMessage: { message: Dialog.Message },
	ClickedAddComponent: {},
	GotAddPickerMessage: { message: PickerMessage },
	CompletedCreateMonitor: { session: Schema.Number, result: LoadOutcome(V2UptimeMonitor) },
	/** `trackProduct("uptime_monitor_created")` was handed to the session SDK. */
	CompletedTrackMonitorCreated: {},
	ClickedSubmitAdd: {},
	CompletedAddComponents: {
		session: Schema.Number,
		result: LoadOutcome(Schema.Array(V2StatusPageComponent)),
	},
	// Incidents
	ClickedNewIncident: { kind: StatusPageIncidentKind },
	GotComposeDialogMessage: { message: Dialog.Message },
	ChangedIncidentKind: { kind: StatusPageIncidentKind },
	ChangedIncidentField: { field: IncidentTextField, value: Schema.String },
	ToggledIncidentComponent: { componentId: StatusPageComponentId },
	ChangedIncidentAutoComplete: { autoComplete: Schema.Boolean },
	SubmittedIncidentWrite: {},
	ClickedIncidentBack: {},
	/** `isPublished`: Publish (or Schedule) rather than Save as draft. */
	SubmittedIncident: { isPublished: Schema.Boolean },
	CompletedCreateIncident: { result: LoadOutcome(V2StatusPageIncident) },
	ClickedPostUpdate: { incidentId: StatusPageIncidentId, isResolving: Schema.Boolean },
	GotUpdateDialogMessage: { message: Dialog.Message },
	ChangedUpdateField: { field: UpdateTextField, value: Schema.String },
	SubmittedUpdateWrite: {},
	ClickedUpdateBack: {},
	SubmittedUpdate: {},
	CompletedPostUpdate: { result: LoadOutcome(V2StatusPageIncident) },
	ClickedPublishIncident: { incidentId: StatusPageIncidentId },
	CompletedPublishIncident: { incidentId: StatusPageIncidentId, result: LoadOutcome(V2StatusPageIncident) },
	ClickedEditIncident: { incidentId: StatusPageIncidentId },
	GotEditIncidentDialogMessage: { message: Dialog.Message },
	ChangedIncidentEditField: { field: IncidentEditField, value: Schema.String },
	ToggledIncidentEditComponent: { componentId: StatusPageComponentId },
	ChangedIncidentEditAutoComplete: { autoComplete: Schema.Boolean },
	SubmittedIncidentEdit: {},
	CompletedSaveIncident: { result: LoadOutcome(V2StatusPageIncident) },
	ClickedDeleteIncident: { incidentId: StatusPageIncidentId },
	ClickedConfirmDeleteIncident: {},
	CompletedDeleteIncident: { result: LoadOutcome(Schema.Void) },
	GotDeleteIncidentDialogMessage: { message: Dialog.Message },
	// Live
	GotUrlCopyMessage: { message: CopyButton.Message },
	// Settings
	ChangedSetting: { field: SettingsTextField, value: Schema.String },
	ToggledPoweredBy: {},
	ClickedPickBrandingImage: { field: BrandingField },
	CompletedPickBrandingImage: {},
	DraggedOverBrandingImage: { field: BrandingField },
	LeftBrandingImage: {},
	ClickedEditBrandingImage: { field: BrandingField },
	GotBrandingDialogMessage: { message: Dialog.Message },
	ChangedBrandingLink: { value: Schema.String },
	SubmittedBrandingLink: {},
	PickedBrandingImage: { field: BrandingField, files: Schema.Array(PickedFile) },
	/** `dataUrl` is null when the browser could not read the file. */
	CompletedReadBrandingImage: {
		field: BrandingField,
		/** The `brandingRead` it started at; a later change supersedes it. */
		read: Schema.Number,
		dataUrl: Schema.NullOr(Schema.String),
	},
	ClickedRemoveBrandingImage: { field: BrandingField },
	PickedThemePreset: { preset: StatusPageThemePreset },
	PickedThemeAppearance: { appearance: StatusPageThemeAppearance },
	ChangedThemeColor: { field: ThemeColorField, value: Schema.String },
	CompletedMountColorPicker: {},
	PickedThemeRadius: { radius: StatusPageThemeRadius },
	PickedThemeFont: { font: StatusPageThemeFont },
	PickedPreviewScheme: { scheme: PreviewScheme },
	PickedPreviewWidth: { width: PreviewWidth },
	PickedPreviewState: { state: PreviewState },
	ClickedDiscardSettings: {},
	ClickedSaveSettings: {},
	CompletedSaveSettings: { result: LoadOutcome(V2StatusPage) },
	ClickedPublish: {},
	CompletedPublish: { result: LoadOutcome(V2StatusPagePublishResult) },
	ClickedRotateToken: {},
	ClickedRevokeToken: {},
	ClickedConfirmBreakGlass: {},
	CompletedRotateToken: { result: LoadOutcome(V2StatusPageBreakGlassToken) },
	CompletedRevokeToken: { result: LoadOutcome(V2StatusPage) },
	GotBreakGlassDialogMessage: { message: Dialog.Message },
	GotTokenCopyMessage: { message: CopyButton.Message },
	ClickedDismissToken: {},
	// Access
	PickedVisibility: { visibility: StatusPageVisibility },
	ChangedPassword: { value: Schema.String },
	ClickedDiscardAccess: {},
	ClickedSaveAccess: {},
	/** Basic settings' one bar when its fields and Who can view both have edits. */
	ClickedDiscardBasic: {},
	ClickedSaveBasic: {},
	CompletedAccessChange: { action: AccessAction, result: LoadOutcome(V2StatusPage) },
	// Custom domain
	CompletedFetchCustomDomain: { key: Schema.String, result: LoadOutcome(V2StatusPageCustomDomain) },
	ClickedRetryCustomDomain: {},
	ChangedCustomDomain: { value: Schema.String },
	SubmittedCustomDomain: {},
	CompletedSetCustomDomain: { result: LoadOutcome(V2StatusPageCustomDomain) },
	ClickedCheckCustomDomain: {},
	CompletedCheckCustomDomain: { result: LoadOutcome(V2StatusPageCustomDomain) },
	ClickedRemoveCustomDomain: {},
	ClickedConfirmRemoveCustomDomain: {},
	CompletedRemoveCustomDomain: { result: LoadOutcome(V2StatusPageCustomDomain) },
	GotRemoveCustomDomainDialogMessage: { message: Dialog.Message },
	/** `key` names the copied DNS value: one copy status serves every row. */
	GotDnsCopyMessage: { key: Schema.String, message: CopyButton.Message },
	// Page
	ClickedDeletePage: {},
	ClickedConfirmDeletePage: {},
	CompletedDeletePage: { result: LoadOutcome(Schema.Void) },
	GotDeletePageDialogMessage: { message: Dialog.Message },
	// JSON
	CompletedFetchConfig: { key: Schema.String, result: LoadOutcome(StatusPageConfig) },
	ClickedEditJson: {},
	ChangedJson: { value: Schema.String },
	ClickedResetJson: {},
	ClickedCancelJson: {},
	ClickedApplyJson: {},
	CompletedApplyJson: { result: LoadOutcome(StatusPageConfig) },
	GotJsonCopyMessage: { message: CopyButton.Message },
})
export type Message = typeof Message.Type
