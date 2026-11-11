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
import { defineMessageUnion } from "foldkit/message"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import {
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
	ClickedClosePanel: {},
	PressedEscape: {},
	// Components
	ChangedComponentField: { field: ComponentTextField, value: Schema.String },
	CommittedComponent: {},
	PickedComponentField: { field: ComponentTextField, value: Schema.String },
	ToggledComponentUptime: {},
	CompletedSaveComponent: { result: LoadOutcome(V2StatusPageComponent) },
	ClickedMoveComponent: { componentId: StatusPageComponentId, offset: Schema.Number },
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
	PickedThemePreset: { preset: StatusPageThemePreset },
	PickedThemeAppearance: { appearance: StatusPageThemeAppearance },
	ChangedThemeColor: { field: ThemeColorField, value: Schema.String },
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
	ClickedChangePassword: {},
	ChangedPassword: { value: Schema.String },
	ClickedCancelPassword: {},
	SubmittedPassword: {},
	ClickedRemovePassword: {},
	CompletedAccessChange: { action: AccessAction, result: LoadOutcome(V2StatusPage) },
	// Custom domain
	CompletedFetchCustomDomain: { key: Schema.String, result: LoadOutcome(V2StatusPageCustomDomain) },
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
