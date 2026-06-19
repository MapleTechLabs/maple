// ---------------------------------------------------------------------------
// Local ingest pulse
//
// Cheap "are we receiving telemetry right now?" probe for local mode. The
// local UI polls this every few seconds to drive the header heartbeat. It
// unions a span branch (`service_overview_spans`, the entry-point MV) and a
// log branch (`logs`) over a caller-bounded recent window, returning the row
// count and the most recent timestamp per signal. Each branch is a
// window-bounded, group-less aggregate so it scans almost nothing.
//
// `lastSeen` is stringified in both branches: spans carry `DateTime` and logs
// `DateTime64`, so emitting the raw columns would force a UNION supertype with
// inconsistent precision. `toString_(max(...))` keeps both branches `String`
// and yields a stable ClickHouse datetime literal the UI can parse.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from } from "../query"
import { Logs, ServiceOverviewSpans } from "../tables"
import { unionAll, type CHUnionQuery } from "../union"

export interface LocalIngestPulseOutput {
	readonly signal: string
	readonly count: number
	readonly lastSeen: string
}

export function localIngestPulseQuery(): CHUnionQuery<LocalIngestPulseOutput> {
	const spans = from(ServiceOverviewSpans)
		.select(($) => ({
			signal: CH.lit("spans"),
			count: CH.count(),
			lastSeen: CH.toString_(CH.max_($.Timestamp)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])

	const logs = from(Logs)
		.select(($) => ({
			signal: CH.lit("logs"),
			count: CH.count(),
			lastSeen: CH.toString_(CH.max_($.Timestamp)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimestampTime.gte(param.dateTime("startTime")),
			$.TimestampTime.lte(param.dateTime("endTime")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])

	return unionAll(spans, logs).format("JSON")
}
