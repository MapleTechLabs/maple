import { Schema } from "effect"
import * as Chart from "../../../../charts/chart"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import { ApiBucket, EndpointDetail } from "../model-tabs"

// The API tab's endpoint drawer: one endpoint's page in a sheet over the table.

export const DetailSlot = KeyedSchema(EndpointDetail, LoadFailure)
export type DetailSlot = typeof DetailSlot.Type

export const SeriesSlot = KeyedSchema(Schema.Array(ApiBucket), LoadFailure)
export type SeriesSlot = typeof SeriesSlot.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	/** By span name: the peeked endpoint and its neighbours, warmed so a step lands on data. */
	details: Schema.Record(Schema.String, DetailSlot),
	/** By span name: buckets of a peeked endpoint the tab's sparkline read does not cover. */
	series: Schema.Record(Schema.String, SeriesSlot),
	/** By chart id: the charts are not keyed by endpoint, so a step redraws in place. */
	charts: Schema.Record(Schema.String, Chart.Model),
})
export type Model = typeof Model.Type

export const PEEK_CHART_IDS = ["peek-requests", "peek-latency"] as const

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "sheet"),
	details: {},
	series: {},
	charts: Object.fromEntries(PEEK_CHART_IDS.map((chartId) => [chartId, Chart.init()])),
})
