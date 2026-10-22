import { AlertCheckDocument, AlertDeliveryEventDocument, AlertRuleId } from "@maple/domain/http"
import {
	AlertDestinationRowSchema,
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { AlertRuleSearch } from "../../../route/search"
import * as Menu from "../../../ui/menu"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { PreviewSlot } from "../shared/preview"

// `/alerts/$ruleId`.

const Rows = <S extends Schema.Top>(row: S) => Schema.NullOr(Schema.Array(row))

/** `AlertRuleChecksResponse` (`useAlertRuleChecks`): the newest checks page plus the summary. */
export const ChecksResponse = Schema.Struct({
	checks: Schema.Array(AlertCheckDocument),
	hasMore: Schema.Boolean,
	nextCursor: Schema.NullOr(Schema.String),
	summary: Schema.Struct({
		bucketSeconds: Schema.Number,
		totals: Schema.Struct({
			total: Schema.Number,
			breached: Schema.Number,
			healthy: Schema.Number,
			skipped: Schema.Number,
			error: Schema.Number,
			transitions: Schema.Number,
		}),
		points: Schema.Array(
			Schema.Struct({
				bucket: Schema.String,
				groupKey: Schema.String,
				totalCount: Schema.Number,
				breachedCount: Schema.Number,
				healthyCount: Schema.Number,
				skippedCount: Schema.Number,
				errorCount: Schema.Number,
				transitionCount: Schema.Number,
				observedValue: Schema.NullOr(Schema.Number),
				threshold: Schema.Number,
			}),
		),
	}),
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
})
export type Model = typeof Model.Type
