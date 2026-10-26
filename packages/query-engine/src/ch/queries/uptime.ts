// Typed Uptime Queries
//
// An uptime monitor's checks are root CLIENT spans of the `maple-uptime` service, one per check,
// keyed to the monitor by the `maple.uptime.monitor_id` resource attribute.

import { type DateTime, Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, type CompiledQueryRowSchema } from "@maple-dev/effect-orm/clickhouse"
import {
	UPTIME_MONITOR_ID_ATTRIBUTE,
	UPTIME_SERVICE_NAME,
	UPTIME_TIMING_ATTRIBUTES,
} from "@maple/domain/uptime"
import { DateTimeUtcFromWarehouse } from "../../datetime"
import { CHNumber } from "../schema"
import { orgIdParam, Traces } from "../tables"
import { avgWhere } from "./format"

export interface UptimePhaseTimingsOutput {
	readonly bucket: DateTime.Utc
	/** Checks in the bucket that got a response and carry their phases. */
	readonly timedChecks: number
	readonly dnsMs: number
	readonly connectMs: number
	readonly tlsMs: number
	readonly ttfbMs: number
	readonly transferMs: number
}

export const uptimePhaseTimingsRowSchema = Schema.Struct({
	bucket: DateTimeUtcFromWarehouse,
	timedChecks: CHNumber,
	dnsMs: CHNumber,
	connectMs: CHNumber,
	tlsMs: CHNumber,
	ttfbMs: CHNumber,
	transferMs: CHNumber,
}) satisfies CompiledQueryRowSchema<UptimePhaseTimingsOutput>

/**
 * Per-bucket average of each phase over one monitor's checks that got a response. Averaging over
 * the same checks keeps the stack summing to their mean time; a phase a check skipped counts as 0
 * (TLS on http://, no body read). Checks from before phases were recorded never match.
 */
export function uptimePhaseTimingsQuery() {
	return from(Traces)
		.select(($) => {
			const answered = $.SpanAttributes.get(UPTIME_TIMING_ATTRIBUTES.ttfbMs).neq("")
			const phase = (key: string) => avgWhere(CH.toFloat64OrZero($.SpanAttributes.get(key)), answered)
			return {
				bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
				timedChecks: CH.countIf(answered),
				dnsMs: phase(UPTIME_TIMING_ATTRIBUTES.dnsMs),
				connectMs: phase(UPTIME_TIMING_ATTRIBUTES.connectMs),
				tlsMs: phase(UPTIME_TIMING_ATTRIBUTES.tlsMs),
				ttfbMs: phase(UPTIME_TIMING_ATTRIBUTES.ttfbMs),
				transferMs: phase(UPTIME_TIMING_ATTRIBUTES.transferMs),
			}
		})
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.ServiceName.eq(UPTIME_SERVICE_NAME),
			$.ParentSpanId.eq(""),
			$.ResourceAttributes.get(UPTIME_MONITOR_ID_ATTRIBUTE).eq(param.string("monitorId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}
