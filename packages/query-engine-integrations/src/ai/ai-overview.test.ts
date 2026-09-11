import { describe, expect, it } from "vitest"
import { compileUnionUnsafe } from "@maple-dev/effect-clickhouse"
import { AI_OVERVIEW_BREAKDOWN_MAX } from "@maple/domain/http"
import { aiOverviewBreakdownQuery, aiOverviewSeriesQuery, aiOverviewTotalsQuery } from "./ai-overview"

const params = {
	orgId: "org_1",
	startTime: "2026-08-18 00:00:00",
	endTime: "2026-08-19 23:59:59",
	prevStartTime: "2026-08-16 00:00:01",
	prevEndTime: "2026-08-18 00:00:00",
}

/** The series is the only read that cuts buckets. */
const seriesParams = { ...params, bucketSeconds: 300 }

/** The sessions list's key, resolved per trace — the same expression
 *  `aiSessionPageQuery` groups on, so a number here reconciles with a row
 *  there. */
const SESSION_KEY =
	"if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId)"

/** `OrgId = 'x'` on every level that reads a table — a subquery contributes
 *  nothing to the outer query's scope. */
const orgPredicateCount = (sql: string) => sql.split("OrgId = 'org_1'").length - 1

const totalsSql = (opts = {}) => compileUnionUnsafe(aiOverviewTotalsQuery(opts), params).sql
const seriesSql = (opts = {}) => compileUnionUnsafe(aiOverviewSeriesQuery(opts), seriesParams).sql

describe("overview population", () => {
	it("reads ai_trace_index alone", () => {
		for (const sql of [totalsSql(), seriesSql()]) {
			expect(sql).toContain("FROM ai_trace_index")
			// The moment an overview read reaches the span tables it costs what the
			// sessions fan-out costs — seconds, per partition, over a month.
			expect(sql).not.toContain("trace_detail_spans")
			expect(sql).not.toContain("SpanAttributes")
			expect(sql).not.toContain("__PARAM_")
		}
	})

	it("resolves the session per trace, with the sessions list's own key", () => {
		const sql = totalsSql()

		// `max(SessionId)` per trace, because the id sits on the turn-owning span
		// and every other row of the trace reads ''.
		expect(sql).toContain("max(SessionId) AS rawSessionId")
		expect(sql).toContain(`${SESSION_KEY} AS sessionId`)
	})

	it("nets usage and model calls the way the sessions list nets them", () => {
		const sql = totalsSql()

		// The reporters, the two lookups taken off them once per session, and the
		// netting — a naive sum(Cost) double-counts every wrapper roll-up.
		expect(sql).toContain("AS reporters")
		expect(sql).toContain("AS childClaims")
		expect(sql).toContain("AS reportingIds")
		expect(sql).toContain("AS netted")
		expect(sql).toContain("maxMap")
		expect(sql).not.toContain("sum(Cost)")
		expect(sql).not.toContain("sum(Tokens)")
	})

	it("scopes every level that reads the table to the org", () => {
		// Two levels per branch — the trace keys and the session rows — and two
		// branches.
		expect(orgPredicateCount(totalsSql())).toBe(4)
		expect(compileUnionUnsafe(aiOverviewTotalsQuery(), params).tenantScope).toBe("single-tenant")
		expect(compileUnionUnsafe(aiOverviewSeriesQuery(), seriesParams).tenantScope).toBe("single-tenant")
		expect(compileUnionUnsafe(aiOverviewBreakdownQuery({ dimension: "model" }), params).tenantScope).toBe(
			"single-tenant",
		)
	})

	it("applies each filter as a per-trace existence test, and none when none is given", () => {
		const sql = totalsSql({
			vendorIds: ["eve"],
			serviceNames: ["agent-runner"],
			deploymentEnvs: ["production"],
			models: ["gpt-5.5"],
			agentNames: ["billing-agent"],
			toolNames: ["send_email"],
		})

		// HAVING, not WHERE: a row predicate would narrow the rows the session id
		// is read from, and a model ANDed with a tool can never match one row.
		expect(sql).toContain("countIf(VendorId IN ('eve')) > 0")
		expect(sql).toContain("countIf(ServiceName IN ('agent-runner')) > 0")
		expect(sql).toContain("countIf(DeploymentEnv IN ('production')) > 0")
		expect(sql).toContain("countIf(Model IN ('gpt-5.5')) > 0")
		expect(sql).toContain("countIf(AgentName IN ('billing-agent')) > 0")
		expect(sql).toContain("countIf(ToolName IN ('send_email')) > 0")

		const unfiltered = totalsSql()
		expect(unfiltered).not.toContain("HAVING")
		expect(unfiltered).not.toContain("countIf(VendorId")
	})

	it("selects the sessions that failed with the list's session-level rule", () => {
		const sql = totalsSql({ hasErrors: true })

		// A session-level test, not a trace-level one: a session spans traces and
		// the list matches it when any of its agent spans failed.
		expect(sql).toContain("HAVING sum(ai_trace_index.IsError) > 0")
		expect(sql).toContain(`${SESSION_KEY} IN (SELECT`)
		expect(totalsSql()).not.toContain("sum(ai_trace_index.IsError) > 0")
	})
})

describe("the measures every grouping reports", () => {
	it("counts a session once and files it under the bucket it started in", () => {
		const sql = seriesSql()

		// `count()`, not `uniqExact`: the level below is already one row per
		// session, and a session has exactly one first span — so the buckets sum
		// to the totals.
		expect(sql).toContain("count() AS sessions")
		expect(sql).toContain("countIf(errorSpans > 0) AS erroredSessions")
		expect(sql).toContain("min(ai_trace_index.Timestamp) AS sessionStart")
		expect(sql).toContain("toStartOfInterval(sessionStart, INTERVAL 300 SECOND)")
		expect(sql).toContain("GROUP BY bucket")
		// The totals are their own un-bucketed read, because quantiles do not
		// merge — a p95 folded from the series is not a p95.
		expect(totalsSql()).not.toContain("toStartOfInterval")
	})

	it("guards every quantile against the empty group", () => {
		const sql = totalsSql()

		// A quantile over no rows is NULL, which the row schema refuses.
		for (const measure of [
			"sessionDurationP50Ns",
			"sessionDurationP95Ns",
			"llmDurationP50Ns",
			"llmDurationP95Ns",
		]) {
			expect(sql).toContain(`AS ${measure}`)
		}
		expect(sql).toContain("ifNull(ifNotFinite(quantile(0.95)(sessionDurationNs), 0), 0)")
		// The model-call latency is a SPAN quantile taken at a level whose rows
		// are sessions, which is what the array carries it up for.
		expect(sql).toContain("quantileArray(0.5)(llmDurations)")
		expect(sql).toContain("groupArrayIf(2000)(ai_trace_index.Duration, ai_trace_index.IsLlmCall = 1)")
	})

	it("measures the extent of the session, not the start of its last span", () => {
		// Without the `+ Duration` a session whose trace is one long span reports
		// a duration of 0, and every other session under-reports by the
		// last-starting span's own duration.
		expect(totalsSql()).toContain(
			"max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) - toUnixTimestamp64Nano(min(ai_trace_index.Timestamp)) AS sessionDurationNs",
		)
	})
})

describe("the breakdown's dimensions", () => {
	const breakdownSql = (opts: Parameters<typeof aiOverviewBreakdownQuery>[0]) =>
		compileUnionUnsafe(aiOverviewBreakdownQuery(opts), params).sql

	it("keys each dimension by the column the span carries it in", () => {
		expect(breakdownSql({ dimension: "model" })).toContain("toString(ai_trace_index.Model) AS key")
		expect(breakdownSql({ dimension: "agent" })).toContain("toString(ai_trace_index.AgentName) AS key")
		expect(breakdownSql({ dimension: "service" })).toContain(
			"toString(ai_trace_index.ServiceName) AS key",
		)
		expect(breakdownSql({ dimension: "environment" })).toContain(
			"toString(ai_trace_index.DeploymentEnv) AS key",
		)
		expect(breakdownSql({ dimension: "vendor" })).toContain("toString(ai_trace_index.VendorId) AS key")
		expect(breakdownSql({ dimension: "tool" })).toContain("toString(ai_trace_index.ToolName) AS key")
	})

	it("reads a model over model calls and a tool over tool calls, and the rest over every span", () => {
		// The predicate, not the `sumIf` measures every read carries: a model
		// keys off a column only a model call fills, and a tool off one only a
		// tool call fills, so the population is narrowed rather than left to
		// answer `''` for every other span.
		expect(breakdownSql({ dimension: "model" })).toContain("AND ai_trace_index.IsLlmCall = 1")
		expect(breakdownSql({ dimension: "tool" })).toContain("AND ai_trace_index.IsToolCall = 1")
		const byService = breakdownSql({ dimension: "service" })
		expect(byService).not.toContain("AND ai_trace_index.IsLlmCall = 1")
		expect(byService).not.toContain("AND ai_trace_index.IsToolCall = 1")
	})

	it("measures both windows over the keys the current window ranked, and counts the rest", () => {
		const sql = breakdownSql({ dimension: "model" })

		// The previous branch is restricted to the same keys, so a key that
		// stopped being used still shows what it cost.
		expect(sql.split("key IN (SELECT").length - 1).toBe(2)
		expect(sql).toContain(`LIMIT ${AI_OVERVIEW_BREAKDOWN_MAX}`)
		expect(sql).toContain("uniqExact(toString(ai_trace_index.Model)) AS keyCount")
		expect(sql).toContain("'keys' AS period")
	})

	it("never ranks more keys than the table can show", () => {
		expect(breakdownSql({ dimension: "tool", limit: 3 })).toContain("LIMIT 3")
		expect(breakdownSql({ dimension: "tool", limit: 500 })).toContain(
			`LIMIT ${AI_OVERVIEW_BREAKDOWN_MAX}`,
		)
	})

	it("groups by the key and by nothing else, so a session counts once per key", () => {
		const sql = breakdownSql({ dimension: "model" })

		expect(sql).toContain("GROUP BY sessionId, key")
		expect(sql).toContain("GROUP BY key")
		// The totals never group by a key — theirs is the constant every read
		// carries so the levels have one shape.
		expect(totalsSql()).toContain("GROUP BY sessionId")
		expect(totalsSql()).not.toContain("GROUP BY sessionId, key")
	})
})
