import { AlertDeliveryEventDocument } from "@maple/domain/http"
import { V2Investigation } from "@maple/domain/http/v2"
import {
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
import { PreviewSlot } from "../shared/preview"

// `/alerts/incidents/$incidentId`.

const Rows = <S extends Schema.Top>(row: S) => Schema.NullOr(Schema.Array(row))

export const Model = Schema.Struct({
	incidentId: Schema.String,
	/** `clockAtSync`: the wall clock to the minute, read when the incident first arrives. */
	nowMs: Schema.NullOr(Schema.Number),
	incidents: Rows(AlertIncidentRowSchema),
	rules: Rows(AlertRuleRowSchema),
	states: Rows(AlertRuleStateRowSchema),
	preview: PreviewSlot,
	deliveries: KeyedSchema(Schema.Array(AlertDeliveryEventDocument), LoadFailure),
	investigation: KeyedSchema(Schema.NullOr(V2Investigation), LoadFailure),
	/** `useAsyncAction`: the create request is running, so repeat clicks cannot start duplicates. */
	isStartingInvestigation: Schema.Boolean,
	chart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type
