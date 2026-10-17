// Source usage
//
// Hourly span and log counts for one source, read from the raw tables
// by the `maple_source_id` resource attribute the gateway stamps. Both tables
// carry a bloom filter on `mapValues(ResourceAttributes)`, so the `has` candidate
// skips granules without the source id and the map equality confirms it.

import { Schema } from "effect"
import { SOURCE_ID_ATTRIBUTE } from "@maple/domain/http"
import * as CH from "@maple-dev/effect-orm/expr"
import {
	from,
	param,
	unionAll,
	type CHUnionQuery,
	type CompiledQueryRowSchema,
} from "@maple-dev/effect-orm/clickhouse"
import { CHNumber } from "../schema"
import { Logs, Traces, orgIdParam, utcSecondsParam } from "../tables"

export { SOURCE_ID_ATTRIBUTE }

export interface SourceUsageOutput {
	readonly signal: string
	/** ClickHouse datetime literal of the hour bucket start. */
	readonly hour: string
	readonly count: number
}

export const sourceUsageRowSchema = Schema.Struct({
	signal: Schema.String,
	hour: Schema.String,
	count: CHNumber,
}) satisfies CompiledQueryRowSchema<SourceUsageOutput>

export function sourceUsageQuery(): CHUnionQuery<SourceUsageOutput> {
	const sourceId = param.string("sourceId")

	const spans = from(Traces)
		.select(($) => ({
			signal: CH.lit("spans"),
			hour: CH.toString_(CH.toStartOfHour($.Timestamp)),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lt(utcSecondsParam("endTime")),
			CH.has(CH.mapValues($.ResourceAttributes), sourceId),
			$.ResourceAttributes.get(SOURCE_ID_ATTRIBUTE).eq(sourceId),
		])
		.groupBy("hour")

	const logs = from(Logs)
		.select(($) => ({
			signal: CH.lit("logs"),
			hour: CH.toString_(CH.toStartOfHour($.Timestamp)),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.TimestampTime.gte(utcSecondsParam("startTime")),
			$.TimestampTime.lt(utcSecondsParam("endTime")),
			CH.has(CH.mapValues($.ResourceAttributes), sourceId),
			$.ResourceAttributes.get(SOURCE_ID_ATTRIBUTE).eq(sourceId),
		])
		.groupBy("hour")

	return unionAll(spans, logs).format("JSON")
}
