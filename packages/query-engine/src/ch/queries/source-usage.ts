// Source usage
//
// Per-source ingestion volume read from `source_usage_hourly`, the rollup its
// views fill at insert from every signal table by `maple_source_id`. It is a
// SummingMergeTree, so every read sums: unmerged parts hold partial rows.

import { Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { CHNumber } from "../schema"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam, utcSecondsParam } from "../tables"

export const sourceUsageHourlyRowSchema = Schema.Struct({
	/** ClickHouse datetime literal of the hour bucket start. */
	hour: Schema.String,
	spans: CHNumber,
	logs: CHNumber,
	metrics: CHNumber,
	bytes: CHNumber,
})

export type SourceUsageHourlyOutput = typeof sourceUsageHourlyRowSchema.Type

export const sourceUsageTotalsRowSchema = Schema.Struct({
	/** The public `src_` id stamped as `maple_source_id`. */
	sourceId: Schema.String,
	spans: CHNumber,
	logs: CHNumber,
	metrics: CHNumber,
	bytes: CHNumber,
})

export type SourceUsageTotalsOutput = typeof sourceUsageTotalsRowSchema.Type

type Columns = ColumnAccessor<typeof Datasources.sourceUsageHourly.columns>

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
	return from(Datasources.sourceUsageHourly)
		.select(($) => ({ hour: CH.toString_($.Hour), ...volume($) }))
		.where(($) => [...inWindow($), $.SourceId.eq(param.string("sourceId"))])
		.groupBy("hour")
		.orderBy(["hour", "asc"])
		.format("JSON")
}

/** Window totals for every source of an org. Params: orgId, startTime, endTime. */
export function sourceUsageTotalsQuery() {
	return from(Datasources.sourceUsageHourly)
		.select(($) => ({ sourceId: $.SourceId, ...volume($) }))
		.where(inWindow)
		.groupBy("sourceId")
		.orderBy(["bytes", "desc"])
		.format("JSON")
}
