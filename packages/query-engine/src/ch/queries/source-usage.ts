// Source usage
//
// Per-source ingestion volume read from `source_usage_hourly`, the rollup its
// views fill at insert from every signal table by `maple_source_id`. It is a
// SummingMergeTree, so every read sums: unmerged parts hold partial rows.

import { Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import {
	from,
	param,
	type ColumnAccessor,
	type CompiledQueryRowSchema,
} from "@maple-dev/effect-orm/clickhouse"
import { CHNumber } from "../schema"
import { SourceUsageHourly, orgIdParam, utcSecondsParam } from "../tables"

export interface SourceUsageHourlyOutput {
	/** ClickHouse datetime literal of the hour bucket start. */
	readonly hour: string
	readonly spans: number
	readonly logs: number
	readonly metrics: number
	readonly bytes: number
}

export const sourceUsageHourlyRowSchema = Schema.Struct({
	hour: Schema.String,
	spans: CHNumber,
	logs: CHNumber,
	metrics: CHNumber,
	bytes: CHNumber,
}) satisfies CompiledQueryRowSchema<SourceUsageHourlyOutput>

export interface SourceUsageTotalsOutput {
	/** The public `src_` id stamped as `maple_source_id`. */
	readonly sourceId: string
	readonly spans: number
	readonly logs: number
	readonly metrics: number
	readonly bytes: number
}

export const sourceUsageTotalsRowSchema = Schema.Struct({
	sourceId: Schema.String,
	spans: CHNumber,
	logs: CHNumber,
	metrics: CHNumber,
	bytes: CHNumber,
}) satisfies CompiledQueryRowSchema<SourceUsageTotalsOutput>

type Columns = ColumnAccessor<typeof SourceUsageHourly.columns>

/** Bytes are the stored-size estimates of every signal, summed. */
const volume = ($: Columns) => ({
	spans: CH.sum($.SpanCount),
	logs: CH.sum($.LogCount),
	metrics: CH.sum($.MetricCount),
	bytes: CH.sum($.SpanSizeBytes).add(CH.sum($.LogSizeBytes)).add(CH.sum($.MetricSizeBytes)),
})

// `Hour` is the bucket start, so a half-open window on it takes whole hours.
const inWindow = ($: Columns) => [
	$.OrgId.eq(orgIdParam),
	$.Hour.gte(utcSecondsParam("startTime")),
	$.Hour.lt(utcSecondsParam("endTime")),
]

/** Hourly volume for one source. Params: orgId, sourceId, startTime, endTime. */
export function sourceUsageHourlyQuery() {
	return from(SourceUsageHourly)
		.select(($) => ({ hour: CH.toString_($.Hour), ...volume($) }))
		.where(($) => [...inWindow($), $.SourceId.eq(param.string("sourceId"))])
		.groupBy("hour")
		.orderBy(["hour", "asc"])
		.format("JSON")
}

/** Window totals for every source of an org. Params: orgId, startTime, endTime. */
export function sourceUsageTotalsQuery() {
	return from(SourceUsageHourly)
		.select(($) => ({ sourceId: $.SourceId, ...volume($) }))
		.where(inWindow)
		.groupBy("sourceId")
		.orderBy(["bytes", "desc"])
		.format("JSON")
}
