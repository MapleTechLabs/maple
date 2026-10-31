import { V2DashboardTemplate, V2DashboardTemplatePreview } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import { WidgetFailure } from "../kit/widget-data"
import { MetricSeen, ReadinessFilter } from "./model"

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	CompletedFetchTemplates: result(Schema.Array(V2DashboardTemplate)),
	CompletedFetchMetrics: result(Schema.Array(MetricSeen)),
	ElapsedPreviewDelay: { generation: Schema.Number },
	CompletedFetchPreview: result(V2DashboardTemplatePreview),
	CompletedFetchWidget: { key: Schema.String, result: Schema.Result(Schema.Unknown, WidgetFailure) },
	MeasuredPreview: { width: Schema.Number },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotChartMessage: { widgetId: Schema.String, message: Chart.Message },
	ClickedSortColumn: { widgetId: Schema.String, field: Schema.String, isText: Schema.Boolean },
	ChangedSearchDraft: { value: Schema.String },
	ElapsedSearchDebounce: { generation: Schema.Number },
	ChangedFilter: { filter: ReadinessFilter },
	ClickedTemplate: { templateId: Schema.String },
	GotPanelSheetMessage: { message: Dialog.Message },
	ClickedRetry: {},
	ChangedParameter: { key: Schema.String, value: Schema.String },
	ClickedCreate: { templateId: Schema.String },
	CompletedCreate: {
		result: Schema.Result(
			Schema.Struct({ id: Schema.String, name: Schema.String, txid: Schema.NullOr(Schema.String) }),
			LoadFailure,
		),
	},
	CompletedAwaitCreated: { id: Schema.String },
})
export type Message = typeof Message.Type
