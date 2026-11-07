/**
 * The reads behind the MCP search tools: span-name filters (search_traces, query_data)
 * and the trace_index probes that locate a trace without a timestamp (inspect_trace,
 * inspect_span). Edit the window and trace id to a populated snapshot.
 */
import { createHash } from "node:crypto"
import * as CH from "@maple/query-engine/ch"
import * as Bench from "@maple-dev/effect-orm/benchmark"
import { OrgId } from "@maple/domain"

const window = {
	orgId: OrgId.make("org_bench"),
	startTime: "2026-11-06 12:00:00",
	endTime: "2026-11-07 12:00:00",
}
// A trace in the last day of the snapshot, and the tier windows `locateTrace` probes.
const traceId = createHash("md5").update("123456").digest("hex")
const dayTier = { orgId: window.orgId, startTime: "2026-11-06 12:00:00" }
const weekTier = { orgId: window.orgId, startTime: "2026-10-31 12:00:00", endTime: "2026-11-06 12:00:00" }

const breakdown = (id: string, spanName: string) =>
	Bench.query({
		id: `span-name/breakdown/${id}`,
		inputs: { ...window, spanName },
		compile: ({ spanName, ...params }) =>
			CH.compile(
				CH.tracesBreakdownQuery({ metric: "count", groupBy: "span_name", spanName, limit: 20 }),
				params,
			),
		results: "unordered",
	})

const spanSearch = (id: string, spanName: string, contains: boolean) =>
	Bench.query({
		id: `span-search/${id}`,
		inputs: { ...window, spanName, contains },
		compile: ({ spanName, contains, ...params }) =>
			CH.compile(
				CH.spanSearchQuery({
					spanName,
					limit: 20,
					...(contains ? { matchModes: { spanName: "contains" } } : undefined),
				}),
				params,
			),
		results: "ordered",
	})

export default Bench.defineSuite({
	name: "mcp-search-workload",
	dataset: "m4-bench-30m-spans-2026-11-07",
	cases: [
		breakdown("exact-miss", "posthog"),
		breakdown("exact-hit", "db.query"),
		breakdown("display-name", "GET /api/v1/resource7"),
		spanSearch("exact-miss", "posthog", false),
		spanSearch("contains-miss", "posthog", true),
		spanSearch("display-name", "GET /api/v1/resource7", false),
		Bench.query({
			id: "trace-index/probe-unbounded",
			inputs: { orgId: window.orgId, traceId },
			compile: ({ traceId, orgId }) => CH.compile(CH.traceTimeProbeQuery({ traceId }), { orgId }),
			results: "unordered",
		}),
		Bench.query({
			id: "trace-index/probe-day-tier",
			inputs: { ...dayTier, traceId },
			compile: ({ traceId, ...params }) =>
				CH.compile(CH.recentTraceTimeProbeQuery({ traceId }), params),
			results: "unordered",
		}),
		Bench.query({
			id: "trace-index/probe-week-tier",
			inputs: { ...weekTier, traceId },
			compile: ({ traceId, ...params }) =>
				CH.compile(CH.recentTraceTimeProbeQuery({ traceId, endBounded: true }), params),
			results: "unordered",
		}),
	],
})
