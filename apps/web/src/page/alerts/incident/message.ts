import { AlertDeliveryEventDocument, AlertRulePreviewResponse } from "@maple/domain/http"
import { V2AlertSilence, V2Investigation } from "@maple/domain/http/v2"
import {
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { ThemeColors } from "@maple/views/charts/theme-colors"
import { LoadFailure } from "@maple/views/data/load-failure"
import { CheckSummary } from "../shared/check-summary"
import { PreviewFailure } from "../shared/preview"
import * as SilenceDialog from "../silence-dialog/dialog"

const rows = <S extends Schema.Top>(row: S) => ({ orgId: Schema.String, rows: Schema.Array(row) })

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	UpdatedIncidents: rows(AlertIncidentRowSchema),
	UpdatedRules: rows(AlertRuleRowSchema),
	UpdatedRuleStates: rows(AlertRuleStateRowSchema),
	CompletedFetchPreview: {
		key: Schema.String,
		result: Schema.Result(AlertRulePreviewResponse, PreviewFailure),
	},
	CompletedFetchChecks: { key: Schema.String, result: Schema.Result(CheckSummary, LoadFailure) },
	CompletedFetchDeliveries: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(AlertDeliveryEventDocument), LoadFailure),
	},
	CompletedFetchInvestigation: {
		key: Schema.String,
		result: Schema.Result(Schema.NullOr(V2Investigation), LoadFailure),
	},
	ClickedInvestigate: {},
	CompletedCreateInvestigation: { result: Schema.Result(Schema.String, LoadFailure) },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { message: Chart.Message },
	CompletedFetchSilences: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(V2AlertSilence), LoadFailure),
	},
	ClickedSilence: {},
	GotSilenceDialogMessage: { message: SilenceDialog.Message },
})
export type Message = typeof Message.Type
