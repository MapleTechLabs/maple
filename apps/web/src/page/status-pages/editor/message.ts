import { StatusPageComponentId, StatusPageIncidentId, StatusPageIncidentKind } from "@maple/domain"
import {
	StatusPageConfig,
	StatusPagePreviewParams,
	V2StatusPage,
	V2StatusPageBreakGlassToken,
	V2StatusPageComponent,
	V2StatusPageIncident,
	V2StatusPagePublishResult,
	V2UptimeMonitor,
} from "@maple/domain/http/v2"
import {
	StatusPageThemeAppearance,
	StatusPageThemeFont,
	StatusPageThemePreset,
	StatusPageSnapshot,
	StatusPageThemeRadius,
} from "@maple/domain/status-page"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { ComponentTextField, IncidentTextField, SettingsTextField, ThemeColorField } from "../shared/form"
import { PickerMessage } from "../shared/picker"
import { PreviewScheme, PreviewSelection } from "../shared/preview"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

export const UpdateTextField = Schema.Literals(["status", "body"])

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
	OpenedPublicPage: {},
	ElapsedPreviewDebounce: { generation: Schema.Number },
	CompletedFetchPreview: {
		generation: Schema.Number,
		draft: StatusPagePreviewParams,
		result: LoadOutcome(StatusPageSnapshot),
	},
	ReceivedPreviewSelection: { kind: PreviewSelection.fields.kind, id: Schema.String },
	ClickedComponent: { componentId: StatusPageComponentId },
	ClickedIncident: { incidentId: StatusPageIncidentId },
	ClickedClosePanel: {},
	PressedEscape: {},
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
	ClickedSubmitAdd: {},
	CompletedAddComponents: {
		session: Schema.Number,
		result: LoadOutcome(Schema.Array(V2StatusPageComponent)),
	},
	ClickedNewIncident: { kind: StatusPageIncidentKind },
	ChangedIncidentKind: { kind: StatusPageIncidentKind },
	ChangedIncidentField: { field: IncidentTextField, value: Schema.String },
	ToggledIncidentComponent: { componentId: StatusPageComponentId },
	PickedIncidentPublished: { isPublished: Schema.Boolean },
	SubmittedIncident: {},
	CompletedCreateIncident: { result: LoadOutcome(V2StatusPageIncident) },
	ClickedPostUpdate: { incidentId: StatusPageIncidentId, isResolving: Schema.Boolean },
	ChangedUpdateField: { field: UpdateTextField, value: Schema.String },
	SubmittedUpdate: {},
	ClickedCancelUpdate: {},
	/** `generation`: which post answered; the form may have moved on to another one. */
	CompletedPostUpdate: { generation: Schema.Number, result: LoadOutcome(V2StatusPageIncident) },
	ClickedPublishIncident: { incidentId: StatusPageIncidentId },
	CompletedPublishIncident: { incidentId: StatusPageIncidentId, result: LoadOutcome(V2StatusPageIncident) },
	GotUrlCopyMessage: { message: CopyButton.Message },
	ChangedSetting: { field: SettingsTextField, value: Schema.String },
	ToggledPoweredBy: {},
	PickedThemePreset: { preset: StatusPageThemePreset },
	PickedThemeAppearance: { appearance: StatusPageThemeAppearance },
	ChangedThemeColor: { field: ThemeColorField, value: Schema.String },
	PickedThemeRadius: { radius: StatusPageThemeRadius },
	PickedThemeFont: { font: StatusPageThemeFont },
	PickedPreviewScheme: { scheme: PreviewScheme },
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
	ClickedDeletePage: {},
	ClickedConfirmDeletePage: {},
	CompletedDeletePage: { result: LoadOutcome(Schema.Void) },
	GotDeletePageDialogMessage: { message: Dialog.Message },
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
