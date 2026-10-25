import { AlertDestinationId, AlertRulePreviewResponse, DashboardDocument } from "@maple/domain/http"
import { V2ChatConnector } from "@maple/domain/http/v2"
import {
	AlertDestinationRowSchema,
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import * as Combobox from "../../../ui/combobox"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Tooltip from "../../../ui/tooltip"
import * as RadioGroup from "../../../ui/radio-group"
import * as Select from "../../../ui/select"
import { AutocompleteLookup, LookupNames } from "../../kit/autocomplete-lookups"
import * as QueryPanel from "../../kit/query-builder/panel"
import * as TimeRangePicker from "../../kit/time-range-picker"
import * as DestinationDialog from "../destination/dialog"
import * as ChatConnect from "../shared/chat-connect"
import { PreviewFailure } from "../shared/preview"
import { DryRun, TraceFacets } from "./model"

/** The form's free-text fields, each one input. */
export const TextField = Schema.Literals([
	"name",
	"notes",
	"apdexThresholdMs",
	"threshold",
	"thresholdUpper",
	"recoveryValue",
	"windowMinutes",
	"consecutiveBreachesRequired",
	"breachesOutOf",
	"minimumSampleCount",
	"consecutiveHealthyRequired",
	"renotifyIntervalMinutes",
	"notificationTitle",
	"notificationBody",
	"rawQuerySql",
])
export type TextField = typeof TextField.Type

export const SignalKind = Schema.Literals(["builtin", "builder_query", "raw_query"])
export type SignalKind = typeof SignalKind.Type

/** The warning tier's destinations, or the critical tier's. */
export const Tier = Schema.Literals(["warning", "critical"])
export type Tier = typeof Tier.Type

const Failure = Schema.Struct({ title: Schema.String, message: Schema.String })

export const Message = defineMessageUnion({
	UpdatedRules: { orgId: Schema.String, rows: Schema.Array(AlertRuleRowSchema) },
	UpdatedRuleStates: { orgId: Schema.String, rows: Schema.Array(AlertRuleStateRowSchema) },
	UpdatedIncidents: { orgId: Schema.String, rows: Schema.Array(AlertIncidentRowSchema) },
	UpdatedDestinations: { orgId: Schema.String, rows: Schema.Array(AlertDestinationRowSchema) },
	/** The `alert_rules` sync gave up, or sat loading past the timeout, while an edit waited on it. */
	FailedLoadRules: { orgId: Schema.String },
	/** The widget's dashboard as the collection answers (empty when it has no such board). */
	UpdatedSourceDashboard: { orgId: Schema.String, dashboards: Schema.Array(DashboardDocument) },
	FailedLoadDashboards: { orgId: Schema.String },
	ClickedReloadPage: {},
	ReloadedPage: {},
	GeneratedDraftId: { id: Schema.String },
	CompletedReadClock: { nowMs: Schema.Number },
	CompletedReadIsAdmin: { isAdmin: Schema.Boolean },
	CompletedFetchConnectors: { connectors: Schema.Array(V2ChatConnector) },
	CompletedFetchTraceFacets: { key: Schema.String, result: Schema.Result(TraceFacets, LoadFailure) },
	CompletedFetchAutocomplete: {
		key: Schema.String,
		lookup: AutocompleteLookup,
		result: Schema.Result(LookupNames, LoadFailure),
	},
	CompletedFetchPreview: {
		key: Schema.String,
		isSaved: Schema.Boolean,
		result: Schema.Result(AlertRulePreviewResponse, PreviewFailure),
	},
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotChartMessage: { message: Chart.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	ClickedSignalKind: { kind: SignalKind },
	GotRadioMessage: { group: Schema.Literals(["signal", "severity", "interval"]), message: RadioGroup.Message },
	ClickedOpenInBuilder: {},
	GotQueryPanelMessage: { message: QueryPanel.Message },
	GotSelectMessage: { id: Schema.String, message: Select.Message },
	GotComboMessage: { id: Schema.String, message: Combobox.Message },
	ChangedField: { field: TextField, value: Schema.String },
	ChangedEscalationField: { field: Schema.Literals(["threshold", "recoveryValue"]), value: Schema.String },
	ClickedAddCriticalTier: {},
	ClickedRemoveCriticalTier: {},
	ToggledAlertOnNoData: {},
	/** The query time meter's switch to the shortest interval the query fits. */
	ClickedUseInterval: { minutes: Schema.String },
	ClickedDryRun: {},
	ClickedSendTest: {},
	CompletedTest: {
		isSending: Schema.Boolean,
		key: Schema.String,
		result: Schema.Result(DryRun, Failure),
	},
	ClickedSave: {},
	CompletedSave: { result: Schema.Result(Schema.Void, Failure) },
	/** `trackProduct("alert_rule_created")` was handed to the session SDK. */
	TrackedRuleCreated: {},
	ClickedShowTemplates: {},
	GotTemplatesMessage: { message: Dialog.Message },
	ClickedTemplate: { id: Schema.String },
	ClickedStartBlank: {},
	ClickedSkipTemplates: {},
	ClickedSuggestName: {},
	ChangedTagDraft: { value: Schema.String },
	PressedTagKey: { key: Schema.String },
	BlurredTagInput: {},
	ClickedRemoveTag: { tag: Schema.String },
	ClickedAddNotes: {},
	ToggledSqlCollapsed: {},
	ClickedSqlToken: { token: Schema.String },
	CompletedInsertSqlToken: { sql: Schema.String, caret: Schema.Number },
	CompletedFocusSql: {},
	ToggledMessageTemplate: {},
	ClickedTemplateVariable: { key: Schema.String },
	GotMenuMessage: { id: Schema.String, message: Menu.Message },
	ClickedRemoveDestination: { tier: Tier, id: AlertDestinationId },
	GotDestinationDialogMessage: { message: DestinationDialog.Message },
	GotIssuesTooltipMessage: { message: Tooltip.Message },
	GotChatConnectMessage: { message: ChatConnect.Message },
	FailedLoadProviderLogo: { type: Schema.String },
})
export type Message = typeof Message.Type
