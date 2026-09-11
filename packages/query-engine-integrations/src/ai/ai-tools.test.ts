import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileUnionUnsafe, compileUnsafe, type CompiledQuery } from "@maple-dev/effect-clickhouse"
import {
	aiToolErrorOccurrencesQuery,
	aiToolErrorOccurrencesRowSchema,
	aiToolErrorSessionsQuery,
	aiToolErrorSessionsRowSchema,
	aiToolErrorsQuery,
	aiToolErrorsRowSchema,
	aiToolsBreakdownsQuery,
	aiToolsSeriesKind,
	aiToolsSeriesQuery,
	aiToolsTotalsQuery,
	AI_TOOLS_BREAKDOWN_LIMIT,
	AI_TOOLS_SERIES_MAX_KEYS,
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

/** The error reads name the tool by param rather than by opts. */
const errorParams = { ...params, toolName: "search_traces" }

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
		expect(orgPredicateCount(compileUnsafe(aiToolsBreakdownsQuery(), params).sql)).toBe(3)
		expect(compileUnsafe(aiToolsBreakdownsQuery(), params).tenantScope).toBe("single-tenant")
		expect(compileUnionUnsafe(aiToolsTotalsQuery(), totalsParams).tenantScope).toBe("single-tenant")
		// The three error reads name the tool by param and read the span table
		// inside a trace-id subquery, so the index scan is scoped too.
		for (const compiled of [
			compileUnsafe(aiToolErrorsQuery(), errorParams),
			compileUnsafe(aiToolErrorSessionsQuery(), errorParams),
			compileUnsafe(aiToolErrorOccurrencesQuery(), errorParams),
		]) {
			expect(compiled.tenantScope).toBe("single-tenant")
			expect(compiled.sql).toContain("OrgId = 'org_1'")
		}
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

	it("re-scopes every read, and the series' own ranking subquery", () => {
		const scoped = { search: "run", failingOnly: true }
		const series = compileUnsafe(aiToolsSeriesQuery(scoped), params).sql
		// Twice in the series: once for the points, once for the top-N ranking —
		// otherwise the legend ranks a population the chart is not drawing.
		expect(series.split("ILIKE '%run%'").length - 1).toBe(2)
		expect(series.split("IsError = 1").length - 1).toBe(2)

		for (const sql of [
			compileUnionUnsafe(aiToolsTotalsQuery(scoped), totalsParams).sql,
			compileUnsafe(aiToolsBreakdownsQuery(scoped), params).sql,
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
			{
				period: "previous",
				calls: 0,
				sessions: 0,
				errors: 0,
				p50: 0,
				p90: 0,
				p95: 0,
				firstSeen: "",
				lastSeen: "",
			},
		])
		expect(rows[0]?.period).toBe("previous")
	})
})

describe("aiToolsBreakdownsQuery", () => {
	it("drops the selection's own tool and keeps the rest", () => {
		const { sql } = compileUnsafe(
			aiToolsBreakdownsQuery({ tool: "search_traces", model: "gpt-5" }),
			params,
		)

		expect(sql).toContain("toolName AS key")
		// The table exists to pick a DIFFERENT tool, so it keeps the model filter
		// and drops the tool one — otherwise it returns the single row the user
		// already clicked.
		expect(sql).toContain(`${MODEL_EXPR} = 'gpt-5'`)
		expect(sql).not.toContain("ToolName = 'search_traces'")
	})

	it("returns the busiest rows, with the last call under each key", () => {
		const { sql } = compileUnsafe(aiToolsBreakdownsQuery(), params)

		expect(sql).toContain("toString(max(ts)) AS lastSeen")
		expect(sql).toContain("ORDER BY calls DESC, key ASC")
		expect(sql).toContain(`LIMIT ${AI_TOOLS_BREAKDOWN_LIMIT}`)
	})
})

describe("aiToolsSeriesQuery split", () => {
	it("merges every key inside the query when the caller asks for none", () => {
		const selection = { tool: "search_traces", split: "none" } as const
		expect(aiToolsSeriesKind(selection)).toBe("none")

		const { sql } = compileUnsafe(aiToolsSeriesQuery(selection), params)

		// One series over the whole selection: no top-N subquery, and therefore
		// no `other` fold — the quantiles and the session count are the measured
		// ones rather than a client-side merge of per-model series.
		expect(sql).not.toContain("top_series_keys")
		expect(sql).not.toContain(AI_TOOLS_OTHER_SERIES_KEY)
		expect(sql).toContain("'' AS seriesKey")
		expect(sql).toContain("uniqExact(sessionKey) AS sessions")
		expect(sql).toContain("quantile(0.95)(durationNs)")
	})

	it("still derives the kind when the caller names none", () => {
		// The overview sends no `split`, so the derivation is unchanged.
		expect(aiToolsSeriesKind({ tool: "t" })).toBe("model")
		expect(aiToolsSeriesKind({ tool: "t", split: "tool" })).toBe("tool")
	})
})

describe("aiToolsTotalsQuery empty window", () => {
	it("reports no first or last call rather than the epoch", () => {
		const { sql } = compileUnionUnsafe(aiToolsTotalsQuery(), totalsParams)

		// A non-grouped `min()` over zero rows returns the DateTime default, so
		// without the guard an empty window claims a first call in 1970 — which
		// the response contract says is `''`.
		expect(sql).toContain("if(count() = 0, '', toString(min(ts))) AS firstSeen")
		expect(sql).toContain("if(count() = 0, '', toString(max(ts))) AS lastSeen")
	})
})

describe("the tool detail reads", () => {
	it("applies the service at the span level, not only in the trace prefilter", () => {
		// The prefilter names TRACES, so a trace that failed this tool in a
		// second service would otherwise contribute that service's spans too.
		for (const sql of [
			compileUnsafe(aiToolErrorsQuery({ service: "agent" }), errorParams).sql,
			compileUnsafe(aiToolErrorOccurrencesQuery({ service: "agent" }), errorParams).sql,
		]) {
			expect(sql).toContain("trace_detail_spans.ServiceName = 'agent'")
		}
		// `env` has no span column and stays prefilter-only.
		expect(
			compileUnsafe(aiToolErrorsQuery({ env: "production" }), errorParams).sql,
		).toContain("ai_trace_index.DeploymentEnv = 'production'")
	})

	it("truncates payloads by codepoint and reports their size in bytes", () => {
		const { sql } = compileUnsafe(aiToolErrorOccurrencesQuery(), errorParams)

		// `left` counts BYTES and would cut a multi-byte codepoint in half.
		expect(sql).not.toContain("left(")
		expect(sql).toContain("leftUTF8(")
		expect(sql).toContain("AS argumentsBytes")
		expect(sql).toContain("AS resultBytes")
	})

	it("narrows on an error type only when one was passed", () => {
		// `''` is a real group — the failures that named no type — so the
		// predicate is on presence of the opt, not on truth of the value.
		expect(compileUnsafe(aiToolErrorSessionsQuery(), errorParams).sql).not.toContain(
			"errorType =",
		)
		expect(
			compileUnsafe(aiToolErrorSessionsQuery({ errorType: "" }), errorParams).sql,
		).toContain("errorType = ''")
		expect(
			compileUnsafe(aiToolErrorSessionsQuery({ errorType: "Timeout" }), errorParams).sql,
		).toContain("errorType = 'Timeout'")
	})

	it("decodes each read through its declared row schema", () => {
		const errors = compileUnsafe(aiToolErrorsQuery(), errorParams, {
			rowSchema: aiToolErrorsRowSchema,
		})
		expect(
			decodeRows(errors, [
				{
					errorType: "TimeoutError",
					message: "timed out",
					calls: 4,
					sessions: 2,
					firstSeen: "2026-08-18 00:00:00",
					lastSeen: "2026-08-18 01:00:00",
				},
			])[0],
		).toMatchObject({ calls: 4, sessions: 2 })

		const sessions = compileUnsafe(aiToolErrorSessionsQuery(), errorParams, {
			rowSchema: aiToolErrorSessionsRowSchema,
		})
		expect(
			decodeRows(sessions, [
				{
					sessionId: "s1",
					agentName: "agent",
					model: "gpt-5",
					// Quoted on a gateway that refuses the 64-bit setting, which is
					// why every count here is `CHNumber` and not `Schema.Number`.
					hits: "7",
					lastSeen: "2026-08-18 01:00:00",
				},
			])[0],
		).toMatchObject({ hits: 7 })

		const occurrences = compileUnsafe(aiToolErrorOccurrencesQuery(), errorParams, {
			rowSchema: aiToolErrorOccurrencesRowSchema,
		})
		expect(
			decodeRows(occurrences, [
				{
					timestamp: "2026-08-18 01:00:00",
					traceId: "t1",
					spanId: "s1",
					sessionId: "sess",
					agentName: "agent",
					model: "gpt-5",
					errorType: "TimeoutError",
					message: "timed out",
					durationNs: "1500000",
					statusCode: "Error",
					arguments: "{}",
					argumentsBytes: "2",
					result: "",
					resultBytes: 0,
				},
			])[0],
		).toMatchObject({ durationNs: 1_500_000, argumentsBytes: 2, resultBytes: 0 })
	})
})
