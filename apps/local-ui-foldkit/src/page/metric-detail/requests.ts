import { Schema } from "effect"
import { MetricEntry } from "../metrics/catalog"

// What each metric detail read asks for; a cached answer carries it back so the fetch can follow.

const Window = { key: Schema.String, startTime: Schema.String, endTime: Schema.String, apiBase: Schema.String }

export const EntryRequest = Schema.Struct({ ...Window, metricName: Schema.String })
export const TimeseriesRequest = Schema.Struct({ ...Window, entry: MetricEntry, bucketSeconds: Schema.Number })
export const BreakdownRequest = Schema.Struct({ ...Window, entry: MetricEntry })
