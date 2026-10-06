// Pull request review
//
// Per-operation traffic across every service of an org, for reading a pull
// request's diff against production: the hourly rollup for the week the review
// weighs a change by, the minutely one for the hour before and after the
// deploy that shipped it. Both read `service_operations_*`, never raw spans.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, param } from "@maple-dev/effect-orm/clickhouse"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { ServiceOperationsHourly, ServiceOperationsMinutely, orgIdParam } from "../tables"

export interface OperationTrafficOpts {
	/** Only these services; absent means every service of the org. */
	readonly serviceNames?: readonly string[]
	/** Only these span names, for comparing the operations a review saw. */
	readonly spanNames?: readonly string[]
	readonly limit?: number
}

export interface OperationTrafficOutput {
	readonly serviceName: string
	readonly spanName: string
	readonly spanCount: number
	readonly errorCount: number
	readonly p95DurationMs: number
}

const P95_MS = CH.rawExpr(
	"if(sum(SpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95)(DurationQuantiles), 2) / 1000000, 0)",
	T.float64,
)

export function operationTrafficHourlyQuery(opts: OperationTrafficOpts) {
	return from(ServiceOperationsHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			spanName: $.SpanName,
			spanCount: CH.sum($.SpanCount),
			errorCount: CH.sum($.ErrorCount),
			p95DurationMs: P95_MS,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(param.dateTimeSeconds("startTime")),
			$.Hour.lte(param.dateTimeSeconds("endTime")),
			opts.serviceNames?.length ? CH.inList($.ServiceName, opts.serviceNames) : undefined,
			opts.spanNames?.length ? CH.inList($.SpanName, opts.spanNames) : undefined,
		])
		.groupBy("serviceName", "spanName")
		.orderBy(["spanCount", "desc"])
		.limit(opts.limit ?? 2_000)
		.format("JSON")
}

export function operationTrafficMinutelyQuery(opts: OperationTrafficOpts) {
	return from(ServiceOperationsMinutely)
		.select(($) => ({
			serviceName: $.ServiceName,
			spanName: $.SpanName,
			spanCount: CH.sum($.SpanCount),
			errorCount: CH.sum($.ErrorCount),
			p95DurationMs: P95_MS,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Minute.gte(param.dateTimeSeconds("startTime")),
			$.Minute.lt(param.dateTimeSeconds("endTime")),
			opts.serviceNames?.length ? CH.inList($.ServiceName, opts.serviceNames) : undefined,
			opts.spanNames?.length ? CH.inList($.SpanName, opts.spanNames) : undefined,
		])
		.groupBy("serviceName", "spanName")
		.orderBy(["spanCount", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}
