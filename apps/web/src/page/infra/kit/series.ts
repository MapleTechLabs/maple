import { Schema } from "effect"
import { ChartBlock } from "../../../charts/chart"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"

// A metric chart's data as every infra detail page reads it: the long-form rows of an
// `*InfraTimeseries` response and its unit, keyed per metric, with the chart's interaction state.

export const SeriesRow = Schema.Struct({
	bucket: Schema.String,
	attributeValue: Schema.String,
	value: Schema.Number,
})
export const SeriesData = Schema.Struct({ rows: Schema.Array(SeriesRow), unit: Schema.String })
export type SeriesData = typeof SeriesData.Type

export const SeriesSlot = KeyedSchema(SeriesData, LoadFailure)
export type SeriesSlot = typeof SeriesSlot.Type

export const SeriesSlots = Schema.Record(Schema.String, SeriesSlot)
export type SeriesSlots = typeof SeriesSlots.Type

export const ChartModels = Schema.Record(Schema.String, ChartBlock.Model)
export type ChartModels = typeof ChartModels.Type

export const SeriesResult = Schema.Result(SeriesData, LoadFailure)
