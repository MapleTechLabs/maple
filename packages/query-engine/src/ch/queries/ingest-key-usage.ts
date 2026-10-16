// Custom ingest key usage
//
// Hourly span and log counts for one custom ingest key, read from the raw tables
// by the `maple_ingest_key_id` resource attribute the gateway stamps. Both tables
// carry a bloom filter on `mapValues(ResourceAttributes)`, so the `has` candidate
// skips granules without the key id and the map equality confirms the key.

import { Schema } from "effect"
import { INGEST_KEY_ID_ATTRIBUTE } from "@maple/domain/http"
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

export { INGEST_KEY_ID_ATTRIBUTE }

export interface IngestKeyUsageOutput {
	readonly signal: string
	/** ClickHouse datetime literal of the hour bucket start. */
	readonly hour: string
	readonly count: number
}

export const ingestKeyUsageRowSchema = Schema.Struct({
	signal: Schema.String,
	hour: Schema.String,
	count: CHNumber,
}) satisfies CompiledQueryRowSchema<IngestKeyUsageOutput>

export function ingestKeyUsageQuery(): CHUnionQuery<IngestKeyUsageOutput> {
	const keyId = param.string("keyId")

	const spans = from(Traces)
		.select(($) => ({
			signal: CH.lit("spans"),
			hour: CH.toString_(CH.toStartOfHour($.Timestamp)),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lte(utcSecondsParam("endTime")),
			CH.has(CH.mapValues($.ResourceAttributes), keyId),
			$.ResourceAttributes.get(INGEST_KEY_ID_ATTRIBUTE).eq(keyId),
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
			$.TimestampTime.lte(utcSecondsParam("endTime")),
			CH.has(CH.mapValues($.ResourceAttributes), keyId),
			$.ResourceAttributes.get(INGEST_KEY_ID_ATTRIBUTE).eq(keyId),
		])
		.groupBy("hour")

	return unionAll(spans, logs).format("JSON")
}
