import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileUnionUnsafe, compileUnsafe, type CompiledQuery } from "@maple-dev/effect-clickhouse"
import {
	aiToolsBreakdownsQuery,
	aiToolsSeriesKind,
	aiToolsSeriesQuery,
	aiToolsSessionsQuery,
	aiToolsTotalsQuery,
	AI_TOOLS_BREAKDOWN_LIMIT,
	AI_TOOLS_SERIES_MAX_KEYS,
	AI_TOOLS_SESSIONS_LIMIT,
} from "./ai-tools"
import { AI_TOOLS_OTHER_SERIES_KEY } from "@maple/domain/http"

const params = {
	orgId: "org_1",
	startTime: "2026-08-18 00:00:00",
	endTime: "2026-08-19 23:59:59",
	bucketSeconds: 300,
}

/** The totals read is the only one that sees a second window. */
const totalsParams = {
	...params,
	prevStartTime: "2026-08-16 00:00:01",
	prevEndTime: "2026-08-18 00:00:00",
}

/** The two-step model attribution, as it compiles — the parent model call's
 *  model, else the trace's. A tool row never carries one itself. */
const MODEL_EXPR = "if(ifNull(parent.Model, '') != '', ifNull(parent.Model, ''), trace.traceModel)"

/** The sessions list's key, resolved per trace — the same expression
 *  `aiSessionPageQuery` groups on, so a row here links to a row there. */
const SESSION_KEY = "if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId)"

const decodeRows = <T>(compiled: CompiledQuery<T>, rows: ReadonlyArray<Record<string, unknown>>) =>
	Effect.runSync(compiled.decodeRows(rows))

/** `OrgId = 'x'` on every level that reads a table — a subquery contributes
 *  nothing to the outer query's scope. */
const orgPredicateCount = (sql: string) => sql.split("OrgId = 'org_1'").length - 1

describe("tool call population", () => {
	it("reads ai_trace_index alone, filtered to tool calls", () => {
		const { sql } = compileUnsafe(aiToolsSeriesQuery(), params)

		expect(sql).toContain("FROM ai_trace_index")
		expect(sql).toContain("ai_trace_index.IsToolCall = 1")
		// The whole page is the index. The moment it reaches the span tables it
		// costs what the sessions fan-out costs — seconds, per partition.
		expect(sql).not.toContain("trace_detail_spans")
		expect(sql).not.toContain("SpanAttributes")
	})

	it("attributes a tool call's model to its parent span, then to its trace", () => {
		const { sql } = compileUnsafe(aiToolsSeriesQuery(), params)

		// Step one: the index rows that DO carry a model, joined on the tool
		// span's parent. Left, because a tool span under a workflow node has no
		// model-bearing parent and must still be counted.
		expect(sql).toContain(
			"LEFT JOIN (SELECT\n          TraceId AS TraceId,\n          SpanId AS SpanId,\n          Model AS Model",
		)
		expect(sql).toContain(
			"ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)",
		)
		// Step two: the trace's own model. Inner, because every tool call of the
		// window belongs to a trace of the window.
		expect(sql).toContain("anyIf(Model, Model != '') AS traceModel")
		expect(sql).toContain("INNER JOIN")
		expect(sql).toContain(`${MODEL_EXPR} AS modelName`)
	})

	it("resolves the session per trace, with the sessions list's own key", () => {
		const { sql } = compileUnsafe(aiToolsSeriesQuery(), params)

		// `max(SessionId)` per trace, because the id sits on the turn-owning span
		// and every other row of the trace reads ''. Keyed per tool ROW instead,
		// nearly every tool call would become its own `trace:` session.
		expect(sql).toContain("max(SessionId) AS rawSessionId")
		expect(sql).toContain(`${SESSION_KEY} AS sessionKey`)
		expect(sql).toContain("uniqExact(sessionKey) AS sessions")
	})

	it("scopes every level that reads the table to the org", () => {
		// Three reads of `ai_trace_index` per aggregation level: the tool calls,
		// the parent models, the trace facts. The series adds a second copy of all
		// three for its top-N ranking.
		expect(orgPredicateCount(compileUnsafe(aiToolsSessionsQuery(), params).sql)).toBe(3)
		expect(compileUnsafe(aiToolsSessionsQuery(), params).tenantScope).toBe("single-tenant")
		expect(compileUnionUnsafe(aiToolsTotalsQuery(), totalsParams).tenantScope).toBe("single-tenant")
		expect(compileUnionUnsafe(aiToolsBreakdownsQuery(), params).tenantScope).toBe("single-tenant")
	})

	it("applies the selection where each half of it can be applied", () => {
		const { sql } = compileUnsafe(
			aiToolsSeriesQuery({ tool: "search_traces", model: "gpt-5", service: "agent", env: "production" }),
			params,
		)

		expect(sql).toContain("ai_trace_index.ToolName = 'search_traces'")
		expect(sql).toContain("ai_trace_index.ServiceName = 'agent'")
		expect(sql).toContain("ai_trace_index.DeploymentEnv = 'production'")
		// The model is an expression over the joins, not a column, so it is the
		// one filter that cannot be pushed onto the index scan.
		expect(sql).toContain(`${MODEL_EXPR} = 'gpt-5'`)
	})

	it("searches tool names as a substring, with the needle's wildcards escaped", () => {
		const { sql } = compileUnsafe(aiToolsSeriesQuery({ search: "search_" }), params)

		// A substring, not a prefix — the toolbar is a search box. `_` is a
		// single-character LIKE wildcard, so an unescaped needle would match
		// `searchX` and every reader would call that a bug.
		// Doubled in the SQL because the literal encoder escapes the backslash —
		// the same shape the errors namespace-prefix filter emits.
		expect(sql).toContain("ai_trace_index.ToolName ILIKE '%search\\\\_%'")
	})

	it("keeps only failed calls when the toolbar asks for them", () => {
		expect(compileUnsafe(aiToolsSeriesQuery({ failingOnly: true }), params).sql).toContain(
			"ai_trace_index.IsError = 1",
		)
		// Absent is not `false`: no predicate at all, so the errors measure still
		// counts against the whole population.
		expect(compileUnsafe(aiToolsSeriesQuery(), params).sql).not.toContain("IsError = 1")
	})

	it("re-scopes all four reads, and the series' own ranking subquery", () => {
		const scoped = { search: "run", failingOnly: true }
		const series = compileUnsafe(aiToolsSeriesQuery(scoped), params).sql
		// Twice in the series: once for the points, once for the top-N ranking —
		// otherwise the legend ranks a population the chart is not drawing.
		expect(series.split("ILIKE '%run%'").length - 1).toBe(2)
		expect(series.split("IsError = 1").length - 1).toBe(2)

		for (const sql of [
			compileUnionUnsafe(aiToolsTotalsQuery(scoped), totalsParams).sql,
			compileUnionUnsafe(aiToolsBreakdownsQuery(scoped), params).sql,
			compileUnsafe(aiToolsSessionsQuery(scoped), params).sql,
		]) {
			expect(sql).toContain("ILIKE '%run%'")
			expect(sql).toContain("IsError = 1")
		}
	})

	it("counts zero-duration tool calls", () => {
		const { sql } = compileUnsafe(aiToolsSeriesQuery(), params)

		// Structured-output pseudo-tools complete instantly and several SDKs emit
		// them. They are calls; excluding them would move every percentile.
		expect(sql).not.toContain("Duration > 0")
		expect(sql).not.toContain("Duration != 0")
	})
})

describe("aiToolsSeriesQuery", () => {
	it("keys the series by tool until a tool is picked, then by model", () => {
		expect(aiToolsSeriesKind({})).toBe("tool")
		expect(aiToolsSeriesKind({ model: "gpt-5" })).toBe("tool")
		expect(aiToolsSeriesKind({ tool: "search_traces" })).toBe("model")
		// Both picked is a single series, and the tool is what names it.
		expect(aiToolsSeriesKind({ tool: "search_traces", model: "gpt-5" })).toBe("tool")

		expect(compileUnsafe(aiToolsSeriesQuery(), params).sql).toContain("if(toolName IN (SELECT")
		expect(compileUnsafe(aiToolsSeriesQuery({ tool: "t" }), params).sql).toContain("if(modelName IN (SELECT")
	})

	it("buckets by the caller's interval and folds the long tail into one key", () => {
		const { sql } = compileUnsafe(aiToolsSeriesQuery(), params)

		expect(sql).toContain("toStartOfInterval(ts, INTERVAL 300 SECOND)")
		expect(sql).toContain(`, toolName, '${AI_TOOLS_OTHER_SERIES_KEY}') AS seriesKey`)
		// Ranked, not truncated: the tail is folded so the stack still totals what
		// the tiles report. The key breaks ties so a series cannot swap in and out
		// of `other` between two loads of the same window.
		expect(sql).toContain("ORDER BY rankCalls DESC, rankKey ASC")
		expect(sql).toContain(`LIMIT ${AI_TOOLS_SERIES_MAX_KEYS}`)
		expect(sql).toContain("GROUP BY bucket, seriesKey")
		expect(sql).toContain("ORDER BY bucket ASC, calls DESC, seriesKey ASC")
	})

	it("decodes a row through the schema derived from its SELECT", () => {
		const compiled = compileUnsafe(aiToolsSeriesQuery(), params)
		const [row] = decodeRows(compiled, [
			{
				bucket: "2026-08-18T00:00:00.000Z",
				seriesKey: "search_traces",
				calls: 12,
				sessions: 3,
				errors: 1,
				p50: 1_500_000,
				p90: 9_000_000,
				p95: 12_000_000,
			},
		])

		// Nanoseconds, undivided — the client formats them.
		expect(row).toEqual({
			bucket: "2026-08-18T00:00:00.000Z",
			seriesKey: "search_traces",
			calls: 12,
			sessions: 3,
			errors: 1,
			p50: 1_500_000,
			p90: 9_000_000,
			p95: 12_000_000,
		})
	})
})

describe("aiToolsTotalsQuery", () => {
	it("measures both windows in one read, each off its own params", () => {
		const { sql } = compileUnionUnsafe(aiToolsTotalsQuery(), totalsParams)

		expect(sql).toContain("'current' AS period")
		expect(sql).toContain("'previous' AS period")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("Timestamp >= '2026-08-18 00:00:00'")
		expect(sql).toContain("Timestamp >= '2026-08-16 00:00:01'")
		// Quantiles do not merge, which is why the tiles are their own read
		// rather than a client-side fold of the chart.
		expect(sql).toContain("quantile(0.95)(durationNs)")
		// Un-bucketed: one row per branch, the whole window in each.
		expect(sql).not.toContain("GROUP BY period")
		expect(sql).not.toContain("toStartOfInterval")
	})

	it("guards an empty window against a NULL percentile", () => {
		const compiled = compileUnionUnsafe(aiToolsTotalsQuery(), totalsParams)

		// A quantile over no rows is NULL, which the row schema refuses — so the
		// query returns 0 and the tile renders a real number.
		expect(compiled.sql).toContain("ifNull(ifNotFinite(quantile(0.5)(durationNs), 0), 0) AS p50")
		const rows = decodeRows(compiled, [
			{ period: "previous", calls: 0, sessions: 0, errors: 0, p50: 0, p90: 0, p95: 0 },
		])
		expect(rows[0]?.period).toBe("previous")
	})
})

describe("aiToolsBreakdownsQuery", () => {
	it("scopes each panel to the OTHER half of the selection", () => {
		const { sql } = compileUnionUnsafe(
			aiToolsBreakdownsQuery({ tool: "search_traces", model: "gpt-5" }),
			params,
		)
		const [tools, models] = sql.split("UNION ALL")

		expect(tools).toContain("'tool' AS kind")
		expect(tools).toContain("toolName AS key")
		// The tool panel exists to pick a DIFFERENT tool, so it keeps the model
		// filter and drops the tool one — otherwise it returns the single row the
		// user already clicked.
		expect(tools).toContain(`${MODEL_EXPR} = 'gpt-5'`)
		expect(tools).not.toContain("ToolName = 'search_traces'")

		expect(models).toContain("'model' AS kind")
		expect(models).toContain("modelName AS key")
		expect(models).toContain("ai_trace_index.ToolName = 'search_traces'")
		expect(models).not.toContain(`${MODEL_EXPR} = 'gpt-5'`)
	})

	it("returns the busiest rows of each panel, with the last call under each key", () => {
		const { sql } = compileUnionUnsafe(aiToolsBreakdownsQuery(), params)

		expect(sql).toContain("toString(max(ts)) AS lastSeen")
		expect(sql).toContain("ORDER BY calls DESC, key ASC")
		expect(sql.split(`LIMIT ${AI_TOOLS_BREAKDOWN_LIMIT}`).length - 1).toBe(2)
	})
})

describe("aiToolsSessionsQuery", () => {
	it("groups the selection's calls by the session that made them", () => {
		const { sql } = compileUnsafe(aiToolsSessionsQuery({ tool: "search_traces" }), params)

		expect(sql).toContain("sessionKey AS sessionId")
		expect(sql).toContain("GROUP BY sessionId")
		// Busiest first, with the id breaking ties so the list is stable.
		expect(sql).toContain("ORDER BY calls DESC, sessionId ASC")
		expect(sql).toContain(`LIMIT ${AI_TOOLS_SESSIONS_LIMIT}`)
		// Labels, taken from whichever matched call carried one.
		expect(sql).toContain("anyIf(agent, agent != '') AS agentName")
		expect(sql).toContain("anyIf(modelName, modelName != '') AS model")
		expect(sql).toContain("anyIf(svc, svc != '') AS serviceName")
		// The matched calls' durations, in nanoseconds — not the session's.
		expect(sql).toContain("max(durationNs) AS maxDurationNs")
		expect(sql).toContain("toString(min(ts)) AS startedAt")
	})

	it("takes the caller's page size", () => {
		expect(compileUnsafe(aiToolsSessionsQuery({ limit: 10 }), params).sql).toContain("LIMIT 10")
	})
})
