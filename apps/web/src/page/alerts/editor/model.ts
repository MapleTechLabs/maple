import { ChartEnvFields } from "@maple/views/charts/chart-env"
import * as Policy from "@maple/domain/policy"
import { AlertDestinationId, AlertRuleId, DashboardDocument } from "@maple/domain/http"
import { V2ChatConnector, V2EscalationChain } from "@maple/domain/http/v2"
import {
	AlertDestinationRowSchema,
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { LookupNames } from "../../kit/autocomplete-lookups"
import * as Chart from "@maple/views/charts/chart"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { AlertsCreateSearch } from "../../../route/search"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as Tooltip from "@maple/views/ui/tooltip"
import * as Select from "@maple/views/ui/select"
import { MetricPageSchema } from "../../kit/query-builder/metric-options"
import { MetricKeysSchema } from "../../kit/query-builder/metrics-body"
import * as QueryPanel from "../../kit/query-builder/panel"
import * as TimeRangePicker from "../../kit/time-range-picker"
import * as DestinationDialog from "../destination/dialog"
import * as ChatConnect from "../shared/chat-connect"
import { PreviewSlot } from "../shared/preview"
import { RuleForm, Tier } from "./form"
import { LiveRows } from "../../kit/load-schemas"

export const Notice = Schema.Struct({
	severity: Schema.Literals(["warning", "error"]),
	message: Schema.String,
})
export type Notice = typeof Notice.Type

/**
 * The draft exists only once ready; `Failed` is the rules sync that never
 * answered, `Unreadable` a rule this build cannot read (a newer build saved it).
 */
export const Status = Schema.Literals(["Loading", "Ready", "Failed", "Unreadable"])
export type Status = typeof Status.Type

/** A dry run's verdict, tagged with the rule it was produced from (`previewIdentityKey`). */
export const DryRun = Schema.Struct({
	key: Schema.String,
	status: Schema.Literals(["breached", "healthy", "skipped"]),
	value: Schema.NullOr(Schema.Number),
})
export type DryRun = typeof DryRun.Type

/** The traces facets the scope pickers read (`autocompleteValues.traces`). */
export const TraceFacets = Schema.Struct({
	services: Schema.Array(Schema.String),
	environments: Schema.Array(Schema.String),
	spanNames: Schema.Array(Schema.String),
	httpMethods: Schema.Array(Schema.String),
	httpStatusCodes: Schema.Array(Schema.String),
})
export type TraceFacets = typeof TraceFacets.Type

export const Model = Schema.Struct({
	search: AlertsCreateSearch,
	status: Status,
	/** The draft's identity; a different source remounts the surface. */
	draftKey: Schema.NullOr(Schema.String),
	form: Schema.NullOr(RuleForm),
	/** The saved rule while editing, what the diff and replay compare against. */
	savedForm: Schema.NullOr(RuleForm),
	editingRuleId: Schema.NullOr(AlertRuleId),
	/** The draft as the surface mounted with it: a field whose value differs from it reads dirty. */
	mountedForm: Schema.NullOr(RuleForm),
	notices: Schema.Array(Notice),
	/** `crypto.randomUUID()` for a fresh query draft, read once on entry. */
	draftId: Schema.NullOr(Schema.String),
	rules: LiveRows(AlertRuleRowSchema),
	states: LiveRows(AlertRuleStateRowSchema),
	incidents: LiveRows(AlertIncidentRowSchema),
	destinations: LiveRows(AlertDestinationRowSchema),
	/** The `alert_rules` sync failed while an edit waits on it. */
	isRulesLoadFailed: Schema.Boolean,
	/** The widget's dashboard when no `chart` snapshot came along. */
	sourceDashboards: Schema.NullOr(Schema.Array(DashboardDocument)),
	isDashboardsLoadFailed: Schema.Boolean,
	grants: Schema.Array(Policy.PermissionName),
	isDefaultDestinationApplied: Schema.Boolean,
	/** The destination the editor pre-selected for a new rule, until the user picks or removes one. */
	autoDestinationId: Schema.NullOr(AlertDestinationId),
	/** The org's chat connectors; `null` until the list answers. */
	connectors: Schema.NullOr(Schema.Array(V2ChatConnector)),
	/** The org's escalation chains a tier can start; `null` until the list answers, or when it failed. */
	escalationChains: Schema.NullOr(Schema.Array(V2EscalationChain)),
	/** The chain list could not be read: a saved chain is kept, not called deleted. */
	isEscalationChainsFailed: Schema.Boolean,
	/** The 24h window the autocomplete provider reads, and the preview's own lookback. */
	autocompleteWindow: Schema.NullOr(TimeWindow),
	previewPreset: Schema.String,
	previewWindow: Schema.NullOr(TimeWindow),
	traceFacets: KeyedSchema(TraceFacets, LoadFailure),
	autocomplete: Schema.Record(Schema.String, KeyedSchema(LookupNames, LoadFailure)),
	/** What the metric picker searched; its page is read while the draft reads metrics. */
	metricSearch: Schema.String,
	/** The search last asked for, so each is read once; `null` after a failure, to ask again. */
	metricRequested: Schema.NullOr(Schema.String),
	metricOptions: Schema.NullOr(Schema.Struct({ search: Schema.String, ...MetricPageSchema.fields })),
	/** Each picked metric's own keys (`name::type`), offered as group-bys and where keys. */
	metricKeys: Schema.Record(Schema.String, MetricKeysSchema),
	metricKeysRequested: Schema.Array(Schema.String),
	preview: PreviewSlot,
	savedPreview: PreviewSlot,
	dryRun: Schema.NullOr(DryRun),
	isDryRunning: Schema.Boolean,
	isSendingTest: Schema.Boolean,
	isSaving: Schema.Boolean,
	/** The switch notice under the mode toggle, cleared by the next switch. */
	kindNotice: Schema.NullOr(Schema.String),
	isNotesOpen: Schema.Boolean,
	/** Tags already in use across the org's rules, sorted; kept by reference while they stay the same. */
	tagSuggestions: Schema.Array(Schema.String),
	isSqlCollapsed: Schema.Boolean,
	isMessageTemplateOpen: Schema.Boolean,
	tagDraft: Schema.String,
	templates: Dialog.Model,
	queryPanels: QueryPanel.Model,
	/** The condition and SQL reducer selects, by id. */
	selects: Schema.Record(Schema.String, Select.Model),
	/** The chip pickers (services, environments, split by, exclude), by id. */
	combos: Schema.Record(Schema.String, Combobox.Model),
	/** The "Add destination" menus (one per tier) and the variable tooltips, by id. */
	menus: Schema.Record(Schema.String, Menu.Model),
	destinationDialog: DestinationDialog.Model,
	/** The action bar's "details" tooltip listing every validation issue. */
	issuesTooltip: Tooltip.Model,
	/** The Add destination menus' workspace connect popup, and the menu it was started from. */
	chatConnect: ChatConnect.Model,
	chatConnectMenuId: Schema.NullOr(Schema.String),
	/** The tier whose "Add destination" opened the destination dialog: a destination made there joins it. */
	destinationTier: Tier,
	brokenLogos: Schema.Array(Schema.String),
	timePicker: TimeRangePicker.Model,
	chart: Chart.Model,
	...ChartEnvFields,
})
export type Model = typeof Model.Type
