import { AlertRuleId, DashboardDocument } from "@maple/domain/http"
import { V2ChatConnector } from "@maple/domain/http/v2"
import {
	AlertDestinationRowSchema,
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { LookupNames } from "../../kit/autocomplete-lookups"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { AlertsCreateSearch } from "../../../route/search"
import * as Combobox from "../../../ui/combobox"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Tooltip from "../../../ui/tooltip"
import * as Select from "../../../ui/select"
import * as QueryPanel from "../../kit/query-builder/panel"
import * as TimeRangePicker from "../../kit/time-range-picker"
import * as DestinationDialog from "../destination/dialog"
import * as ChatConnect from "../shared/chat-connect"
import { PreviewSlot } from "../shared/preview"
import { RuleForm } from "./form"

// `/alerts/create`: `AlertCreatePageContent` and the
// `AlertCreateFormSurface` it mounts once the draft is known.

const Rows = <S extends Schema.Top>(row: S) => Schema.NullOr(Schema.Array(row))

export const Notice = Schema.Struct({
	severity: Schema.Literals(["warning", "error"]),
	message: Schema.String,
})
export type Notice = typeof Notice.Type

/** `RuleInitialization`: the draft exists only once ready; `Failed` is the rules sync that never answered. */
export const Status = Schema.Literals(["Loading", "Ready", "Failed"])
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
	/** The draft's identity (`RuleDraft.key`); a different source remounts the surface. */
	draftKey: Schema.NullOr(Schema.String),
	form: Schema.NullOr(RuleForm),
	/** The saved rule while editing (`savedForm`), what the diff and replay compare against. */
	savedForm: Schema.NullOr(RuleForm),
	editingRuleId: Schema.NullOr(AlertRuleId),
	/** The draft as the surface mounted with it: Base UI fields mark a changed value dirty. */
	mountedForm: Schema.NullOr(RuleForm),
	notices: Schema.Array(Notice),
	/** `crypto.randomUUID()` for a fresh query draft, read once on entry. */
	draftId: Schema.NullOr(Schema.String),
	rules: Rows(AlertRuleRowSchema),
	states: Rows(AlertRuleStateRowSchema),
	incidents: Rows(AlertIncidentRowSchema),
	destinations: Rows(AlertDestinationRowSchema),
	/** `useCollectionLoadFailed` on `alert_rules` while an edit waits on it. */
	isRulesLoadFailed: Schema.Boolean,
	/** The widget's dashboard when no `chart` snapshot came along (`useDashboardsRead`). */
	sourceDashboards: Schema.NullOr(Schema.Array(DashboardDocument)),
	isDashboardsLoadFailed: Schema.Boolean,
	isAdmin: Schema.Boolean,
	isDefaultDestinationApplied: Schema.Boolean,
	/** `useChatConnectors`: `null` until the list answers. */
	connectors: Schema.NullOr(Schema.Array(V2ChatConnector)),
	/** The 24h window the autocomplete provider reads, and the preview's own lookback. */
	autocompleteWindow: Schema.NullOr(TimeWindow),
	previewPreset: Schema.String,
	previewWindow: Schema.NullOr(TimeWindow),
	traceFacets: KeyedSchema(TraceFacets, LoadFailure),
	autocomplete: Schema.Record(Schema.String, KeyedSchema(LookupNames, LoadFailure)),
	preview: PreviewSlot,
	savedPreview: PreviewSlot,
	dryRun: Schema.NullOr(DryRun),
	isDryRunning: Schema.Boolean,
	isSendingTest: Schema.Boolean,
	isSaving: Schema.Boolean,
	/** The switch notice under the mode toggle (`notice`), cleared by the next switch. */
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
	brokenLogos: Schema.Array(Schema.String),
	timePicker: TimeRangePicker.Model,
	chart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type
