import { StatusPageComponentId, StatusPageIncidentId, StatusPageIncidentKind } from "@maple/domain"
import {
	StatusPageConfig,
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
	StatusPageThemeRadius,
} from "@maple/domain/status-page"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import * as CopyButton from "../../../../ui/copy-button"
import * as Dialog from "../../../../ui/dialog"
import { ComponentTextField, IncidentTextField, SettingsTextField, ThemeColorField } from "./form"
import { PreviewScheme } from "./model"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const UpdateTextField = Schema.Literals(["status", "body"])

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchPage: { key: Schema.String, result: outcome(V2StatusPage) },
	CompletedFetchComponents: { key: Schema.String, result: outcome(Schema.Array(V2StatusPageComponent)) },
	CompletedFetchIncidents: { key: Schema.String, result: outcome(Schema.Array(V2StatusPageIncident)) },
	CompletedFetchMonitors: { key: Schema.String, result: outcome(Schema.Array(V2UptimeMonitor)) },
	CompletedFetchSession: { orgId: Schema.String, isAdmin: Schema.Boolean },
	ClickedRetry: {},
	// Components
	ClickedAddComponent: {},
	ClickedEditComponent: { componentId: StatusPageComponentId },
	ChangedComponentField: { field: ComponentTextField, value: Schema.String },
	ToggledComponentUptime: {},
	SubmittedComponent: {},
	CompletedSaveComponent: { result: outcome(V2StatusPageComponent) },
	GotComponentDialogMessage: { message: Dialog.Message },
	ClickedMoveComponent: { componentId: StatusPageComponentId, offset: Schema.Number },
	CompletedReorder: { result: outcome(Schema.Array(V2StatusPageComponent)) },
	ClickedDeleteComponent: { componentId: StatusPageComponentId },
	ClickedConfirmDeleteComponent: {},
	CompletedDeleteComponent: { result: outcome(Schema.Void) },
	GotDeleteComponentDialogMessage: { message: Dialog.Message },
	// Incidents
	ClickedNewIncident: { kind: StatusPageIncidentKind },
	ChangedIncidentField: { field: IncidentTextField, value: Schema.String },
	ToggledIncidentComponent: { componentId: StatusPageComponentId },
	PickedIncidentPublished: { isPublished: Schema.Boolean },
	SubmittedIncident: {},
	CompletedCreateIncident: { result: outcome(V2StatusPageIncident) },
	GotIncidentDialogMessage: { message: Dialog.Message },
	ClickedPostUpdate: { incidentId: StatusPageIncidentId, isResolving: Schema.Boolean },
	ChangedUpdateField: { field: UpdateTextField, value: Schema.String },
	SubmittedUpdate: {},
	CompletedPostUpdate: { result: outcome(V2StatusPageIncident) },
	GotUpdateDialogMessage: { message: Dialog.Message },
	ClickedPublishIncident: { incidentId: StatusPageIncidentId },
	CompletedPublishIncident: { incidentId: StatusPageIncidentId, result: outcome(V2StatusPageIncident) },
	// Settings
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
	CompletedSaveSettings: { result: outcome(V2StatusPage) },
	ClickedPublish: {},
	CompletedPublish: { result: outcome(V2StatusPagePublishResult) },
	ClickedRotateToken: {},
	ClickedRevokeToken: {},
	ClickedConfirmBreakGlass: {},
	CompletedRotateToken: { result: outcome(V2StatusPageBreakGlassToken) },
	CompletedRevokeToken: { result: outcome(V2StatusPage) },
	GotBreakGlassDialogMessage: { message: Dialog.Message },
	GotTokenCopyMessage: { message: CopyButton.Message },
	ClickedDismissToken: {},
	// Page
	ClickedDeletePage: {},
	ClickedConfirmDeletePage: {},
	CompletedDeletePage: { result: outcome(Schema.Void) },
	GotDeletePageDialogMessage: { message: Dialog.Message },
	// JSON
	ClickedEditJson: {},
	ChangedJson: { value: Schema.String },
	ClickedResetJson: {},
	ClickedCancelJson: {},
	ClickedApplyJson: {},
	CompletedApplyJson: { result: outcome(StatusPageConfig) },
	GotJsonCopyMessage: { message: CopyButton.Message },
})
export type Message = typeof Message.Type
