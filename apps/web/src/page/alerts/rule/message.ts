import { AlertCheckDocument, AlertDeliveryEventDocument, AlertIncidentId, AlertRulePreviewResponse } from "@maple/domain/http"
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
import { TimeWindow } from "../../../data/time-range"
import * as Menu from "../../../ui/menu"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { PreviewFailure } from "../shared/preview"
import { CheckStatusFilter, ChecksResponse, SignalSource, StateFilter } from "./model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const rows = <S extends Schema.Top>(row: S) => ({ orgId: Schema.String, rows: Schema.Array(row) })

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	UpdatedRules: rows(AlertRuleRowSchema),
	UpdatedIncidents: rows(AlertIncidentRowSchema),
	UpdatedRuleStates: rows(AlertRuleStateRowSchema),
	UpdatedDestinations: rows(AlertDestinationRowSchema),
	ReadDiagnosisClock: { nowMs: Schema.Number },
	CompletedFetchDeliveries: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(AlertDeliveryEventDocument), LoadFailure),
	},
	CompletedFetchChecks: { key: Schema.String, result: Schema.Result(ChecksResponse, LoadFailure) },
	CompletedFetchPreview: { key: Schema.String, result: Schema.Result(AlertRulePreviewResponse, PreviewFailure) },
	ClickedStateFilter: { filter: StateFilter },
	ClickedCheckStatusFilter: { filter: CheckStatusFilter },
	ClickedSignalSource: { source: SignalSource },
	ClickedRailBucket: { index: Schema.NullOr(Schema.Number) },
	CompletedFetchBucketChecks: {
		request: Schema.Number,
		result: Schema.Result(Schema.Array(AlertCheckDocument), LoadFailure),
	},
	ClickedClearBucket: {},
	ClickedShowAllIncidents: {},
	ClickedLoadMoreChecks: {},
	CompletedLoadMoreChecks: {
		generation: Schema.Number,
		result: Schema.Result(
			Schema.Struct({ checks: Schema.Array(AlertCheckDocument), nextCursor: Schema.NullOr(Schema.String) }),
			LoadFailure,
		),
	},
	/** `setExpanded(!isOpen)`: the header knows whether the panel is open (verdict-driven by default). */
	ClickedDiagnosisHeader: { isOpen: Schema.Boolean },
	ClickedShowAllStages: {},
	ClickedDiagnosisGroup: { groupKey: Schema.String },
	ClickedStage: { stageId: Schema.String, isOpen: Schema.Boolean },
	ClickedShowAllEvidence: { stageId: Schema.String },
	ClickedToggleEnabled: {},
	CompletedToggleEnabled: { result: Schema.Result(Schema.Void, LoadFailure) },
	ClickedOpenInvestigation: { incidentId: AlertIncidentId },
	CompletedOpenInvestigation: { result: Schema.Result(Schema.String, LoadFailure) },
	GotRowMenuMessage: { menuId: Schema.String, message: Menu.Message },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type
