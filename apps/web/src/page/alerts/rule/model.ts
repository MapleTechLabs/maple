import { AlertCheckDocument, AlertDeliveryEventDocument, AlertRuleId } from "@maple/domain/http"
import {
	AlertDestinationRowSchema,
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import * as Policy from "@maple/domain/policy"
import * as Chart from "@maple/views/charts/chart"
import { ChartRuntime } from "@maple/views/charts/chart-runtime"
import { ThemeColors } from "@maple/views/charts/theme-colors"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { AlertRuleSearch } from "../../../route/search"
import { V2AlertSilence } from "@maple/domain/http/v2"
import * as SilenceDialog from "../silence-dialog/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { CheckSummary } from "../shared/check-summary"
import { PreviewSlot } from "../shared/preview"

// `/alerts/$ruleId`.

const Rows = <S extends Schema.Top>(row: S) => Schema.NullOr(Schema.Array(row))

/** `AlertRuleChecksResponse` (`useAlertRuleChecks`): the newest checks page plus the summary. */
export const ChecksResponse = Schema.Struct({
	checks: Schema.Array(AlertCheckDocument),
	hasMore: Schema.Boolean,
	nextCursor: Schema.NullOr(Schema.String),
	summary: CheckSummary,
})
export type ChecksResponse = typeof ChecksResponse.Type

export const StateFilter = Schema.Literals(["all", "open", "resolved"])
export type StateFilter = typeof StateFilter.Type
export const CheckStatusFilter = Schema.Literals(["all", "breached", "healthy", "skipped", "error"])
export type CheckStatusFilter = typeof CheckStatusFilter.Type
export const SignalSource = Schema.Literals(["preview", "checks"])
export type SignalSource = typeof SignalSource.Type

export const SelectedBucket = Schema.Struct({
	index: Schema.Number,
	start: Schema.Number,
	end: Schema.Number,
})

export const Model = Schema.Struct({
	ruleId: AlertRuleId,
	search: AlertRuleSearch,
	window: Schema.NullOr(TimeWindow),
	/** `diagnosisNow`: the wall clock the diagnosis labels read, refreshed with its inputs. */
	nowMs: Schema.Number,
	rules: Rows(AlertRuleRowSchema),
	incidents: Rows(AlertIncidentRowSchema),
	states: Rows(AlertRuleStateRowSchema),
	destinations: Rows(AlertDestinationRowSchema),
	deliveries: KeyedSchema(Schema.Array(AlertDeliveryEventDocument), LoadFailure),
	checks: KeyedSchema(ChecksResponse, LoadFailure),
	preview: PreviewSlot,
	// Local UI state.
	stateFilter: StateFilter,
	checkStatusFilter: CheckStatusFilter,
	signalSource: SignalSource,
	selectedBucket: Schema.NullOr(SelectedBucket),
	/** The selected rail bucket's own checks, and the request that may still write them. */
	bucketChecks: Schema.Array(AlertCheckDocument),
	isBucketLoading: Schema.Boolean,
	bucketRequest: Schema.Number,
	isShowingAllIncidents: Schema.Boolean,
	/** `ChecksPanel`'s "Load 100 more" pages and its cursor (`undefined` = the first page's). */
	extraChecks: Schema.Array(AlertCheckDocument),
	nextCursorOverride: Schema.optionalKey(Schema.NullOr(Schema.String)),
	isLoadingMoreChecks: Schema.Boolean,
	/** Bumped when the panel starts over (window or filter): a load-more for an older one is dropped. */
	checksGeneration: Schema.Number,
	/** `RuleDiagnosisPanel`: the header toggle (`null` follows the verdict), steps and evidence. */
	isDiagnosisExpanded: Schema.NullOr(Schema.Boolean),
	isShowingAllStages: Schema.Boolean,
	selectedGroup: Schema.NullOr(Schema.String),
	stageOpen: Schema.Record(Schema.String, Schema.Boolean),
	stageEvidenceExpanded: Schema.Array(Schema.String),
	isTogglingRule: Schema.Boolean,
	isOpeningInvestigation: Schema.Boolean,
	menus: Schema.Record(Schema.String, Menu.Model),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	chart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	/** `alertSilences.list`: which silence, if any, holds back this rule's notifications. */
	silences: KeyedSchema(Schema.Array(V2AlertSilence), LoadFailure),
	silenceDialog: SilenceDialog.Model,
	/** What the session may do (`Policy.grantsOf`); none until it answers, so Silence stays hidden. */
	grants: Schema.Array(Policy.PermissionName),
})
export type Model = typeof Model.Type
