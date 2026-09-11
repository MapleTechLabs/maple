import { describe, expect, it } from "vitest"
import { Array as Arr, Effect } from "effect"
import { compileUnionUnsafe, compileUnsafe, type CompiledQuery } from "@maple-dev/effect-clickhouse"
import {
	aiToolDescriptionQuery,
	aiToolDescriptionRowSchema,
	aiToolErrorOccurrencesQuery,
	aiToolErrorOccurrencesRowSchema,
	aiToolErrorPayloadSlice,
	aiToolErrorPayloadsQuery,
	aiToolErrorPayloadsRowSchema,
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
	AI_TOOL_OCCURRENCES_LIMIT,
	type AiToolErrorCallKey,
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

/** The description read takes no opts at all — a description is the tool's and
 *  not the selection's — so it is the one read here that names the tool by
 *  param. Every other tool read takes it in the opts, like every other filter. */
const descriptionParams = { ...params, toolName: "search_traces" }

/** The detail page's selection: one tool, everything else the toolbar's. */
const errorSelection = { tool: "search_traces" } as const

/** The two-step model attribution, as it compiles — the parent model call's
 *  model, else the trace's. A tool row never carries one itself. */
const MODEL_EXPR = "if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel)"

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
		// A tool picked and no model: the chart compares the models that tool ran
		// under, which is the read the two-step attribution exists for.
		const { sql } = compileUnsafe(aiToolsSeriesQuery({ tool: "search_traces" }), params)

		// Step one: the index rows that DO carry a model, joined on the tool
		// span's parent. Left, because a tool span under a workflow node has no
		// model-bearing parent and must still be counted.
		expect(sql).toContain(
			"LEFT JOIN (SELECT\n          TraceId AS TraceId,\n          SpanId AS SpanId,\n          anyIf(Model, Model != '') AS parentModel",
		)
		// One parent row per span, whatever models it was indexed under — a second
		// row would double the tool call the join matches.
		expect(sql).toContain("GROUP BY TraceId, SpanId) AS parent")
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
		// Two reads of `ai_trace_index` per aggregation level without a model
		// filter: the tool calls and the trace facts. A model filter adds the
		// parent-model level, and the series a second copy for its top-N ranking.
		expect(orgPredicateCount(compileUnsafe(aiToolsBreakdownsQuery(), params).sql)).toBe(2)
		expect(orgPredicateCount(compileUnsafe(aiToolsBreakdownsQuery({ model: "gpt-5" }), params).sql)).toBe(3)
		expect(compileUnsafe(aiToolsBreakdownsQuery(), params).tenantScope).toBe("single-tenant")
		expect(compileUnionUnsafe(aiToolsTotalsQuery(), totalsParams).tenantScope).toBe("single-tenant")
		for (const compiled of [
			compileUnsafe(aiToolErrorsQuery(errorSelection), params),
			compileUnsafe(aiToolErrorSessionsQuery(errorSelection), params),
			compileUnsafe(aiToolErrorOccurrencesQuery(errorSelection), params),
		]) {
			expect(compiled.tenantScope).toBe("single-tenant")
			expect(compiled.sql).toContain("OrgId = 'org_1'")
		}
	})

	it("joins the parent-model level only where a model is filtered or split by", () => {
		// The join answers "which model called this tool" and nothing else, so a
		// read that neither filters on a model nor keys its series by one pays for
		// a hash table it never reads — 15% of the detail page's totals read.
		const withoutParent = [
			compileUnsafe(aiToolsBreakdownsQuery(), params).sql,
			compileUnionUnsafe(aiToolsTotalsQuery({ tool: "search_traces" }), totalsParams).sql,
			compileUnsafe(aiToolErrorsQuery(errorSelection), params).sql,
			// One tool, one series: the chart is not keyed by model either.
			compileUnsafe(aiToolsSeriesQuery({ tool: "search_traces", split: "none" }), params).sql,
		]
		for (const sql of withoutParent) {
			expect(sql).not.toContain("LEFT JOIN")
			expect(sql).not.toContain("parentModel")
			// The trace's own model is what a call is attributed to instead.
			expect(sql).toContain("trace.traceModel")
		}

		const withParent = [
			compileUnsafe(aiToolsBreakdownsQuery({ model: "gpt-5" }), params).sql,
			// No tool picked and no split named: the chart compares TOOLS.
			// A tool picked without a model is the one that compares models.
			compileUnsafe(aiToolsSeriesQuery({ tool: "search_traces" }), params).sql,
		]
		for (const sql of withParent) {
			expect(sql).toContain("LEFT JOIN")
			expect(sql).toContain("parentModel")
		}
		expect(compileUnsafe(aiToolsSeriesQuery(), params).sql).not.toContain("parentModel")
	})

	it("joins it unconditionally for the two modal reads that PRINT a model", () => {
		// Without this the model beside a failure would be the trace's until the
		// reader sets a model filter and the parent-resolved one after — the same
		// failure described two ways. Both are behind a click, so the join is off
		// the page's critical path; the Errors table, which is on it and prints no
		// model, is the read above that keeps the default.
		for (const sql of [
			compileUnsafe(aiToolErrorSessionsQuery(errorSelection), params).sql,
			compileUnsafe(aiToolErrorOccurrencesQuery(errorSelection), params).sql,
		]) {
			expect(sql).toContain("LEFT JOIN")
			expect(sql).toContain(`${MODEL_EXPR} AS modelName`)
		}
		expect(compileUnsafe(aiToolErrorsQuery(errorSelection), params).sql).not.toContain("parentModel")
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

	it("measures only the periods the caller draws", () => {
		const currentOnly = compileUnionUnsafe(aiToolsTotalsQuery({}, ["current"]), totalsParams).sql

		// The detail page draws one window: no delta tiles, no all-sessions
		// denominator, and each branch it does not draw is its own scan.
		expect(currentOnly).toContain("'current' AS period")
		expect(currentOnly).not.toContain("'previous' AS period")
		expect(currentOnly).not.toContain("'window' AS period")
		expect(currentOnly).not.toContain("UNION ALL")
		expect(currentOnly).not.toContain("2026-08-16 00:00:01")

		// The overview's default is unchanged, and the branches keep their order
		// whatever order the caller lists them in.
		const listed = compileUnionUnsafe(
			aiToolsTotalsQuery({}, ["window", "current"]),
			totalsParams,
		).sql
		expect(listed.indexOf("'current' AS period")).toBeLessThan(listed.indexOf("'window' AS period"))
		expect(listed).not.toContain("'previous' AS period")
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
	it("reads the index alone — the failure's type and message are columns", () => {
		for (const sql of [
			compileUnsafe(aiToolErrorsQuery({ ...errorSelection, model: "gpt-5", service: "agent" }), params)
				.sql,
			compileUnsafe(
				aiToolErrorOccurrencesQuery({ ...errorSelection, model: "gpt-5", service: "agent" }),
				params,
			).sql,
			compileUnsafe(aiToolErrorSessionsQuery(errorSelection), params).sql,
		]) {
			// Migration 0032. Before it these three seeked `trace_detail_spans`
			// inside the traces the index named, which costs by the partitions the
			// window spreads over — seconds to tens of seconds on a week.
			expect(sql).not.toContain("trace_detail_spans")
			expect(sql).not.toContain("SpanAttributes")
			expect(sql).toContain("ai_trace_index.IsError = 1")
			expect(sql).toContain("ai_trace_index.ToolName = 'search_traces'")
		}
		expect(
			compileUnsafe(aiToolErrorsQuery({ ...errorSelection, env: "production" }), params).sql,
		).toContain("ai_trace_index.DeploymentEnv = 'production'")
	})

	it("groups the failures by type and labels each with its latest message", () => {
		const { sql } = compileUnsafe(aiToolErrorsQuery(errorSelection), params)

		expect(sql).toContain("argMax(message, ts) AS message")
		expect(sql).toContain("uniqExact(sessionKey) AS sessions")
		expect(sql).toContain("GROUP BY errorType")
		expect(sql).toContain("ORDER BY calls DESC, errorType ASC")
	})

	it("narrows on an error type only when one was passed", () => {
		// `''` is a real group — the failures that named no type — so the
		// predicate is on presence of the opt, not on truth of the value.
		expect(compileUnsafe(aiToolErrorSessionsQuery(errorSelection), params).sql).not.toContain(
			"errorType =",
		)
		expect(
			compileUnsafe(aiToolErrorSessionsQuery({ ...errorSelection, errorType: "" }), params).sql,
		).toContain("errorType = ''")
		expect(
			compileUnsafe(aiToolErrorSessionsQuery({ ...errorSelection, errorType: "Timeout" }), params)
				.sql,
		).toContain("errorType = 'Timeout'")
	})

	it("narrows the occurrences to one session, and orders them newest first", () => {
		const { sql } = compileUnsafe(
			aiToolErrorOccurrencesQuery({ ...errorSelection, errorType: "Timeout", session: "sess_1" }),
			params,
		)

		expect(sql).toContain("sessionKey = 'sess_1'")
		expect(sql).toContain("ORDER BY timestamp DESC, spanId ASC")
		expect(sql).toContain(`LIMIT ${AI_TOOL_OCCURRENCES_LIMIT}`)
	})

	it("decodes each read through its declared row schema", () => {
		const errors = compileUnsafe(aiToolErrorsQuery(errorSelection), params, {
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

		const sessions = compileUnsafe(aiToolErrorSessionsQuery(errorSelection), params, {
			rowSchema: aiToolErrorSessionsRowSchema,
		})
		expect(
			decodeRows(sessions, [
				{
					sessionId: "s1",
					vendorId: "eve",
					agentName: "agent",
					model: "gpt-5",
					// Quoted on a gateway that refuses the 64-bit setting, which is
					// why every count here is `CHNumber` and not `Schema.Number`.
					hits: "7",
					lastSeen: "2026-08-18 01:00:00",
				},
			])[0],
		).toMatchObject({ hits: 7 })

		const occurrences = compileUnsafe(aiToolErrorOccurrencesQuery(errorSelection), params, {
			rowSchema: aiToolErrorOccurrencesRowSchema,
		})
		expect(
			decodeRows(occurrences, [
				{
					timestamp: "2026-08-18 01:00:00",
					traceId: "t1",
					spanId: "s1",
					sessionId: "sess",
					vendorId: "eve",
					agentName: "agent",
					model: "gpt-5",
					errorType: "TimeoutError",
					message: "timed out",
					durationNs: "1500000",
				},
			])[0],
		).toMatchObject({ durationNs: 1_500_000 })
	})
})

describe("aiToolErrorPayloadsQuery", () => {
	const calls: Arr.NonEmptyReadonlyArray<AiToolErrorCallKey> = [
		{ timestamp: "2026-08-18 04:00:00.000000000", traceId: "t2", spanId: "s2" },
		{ timestamp: "2026-08-18 01:00:00.000000000", traceId: "t1", spanId: "s1" },
	]
	const compiled = compileUnsafe(
		aiToolErrorPayloadsQuery(calls),
		{ orgId: "org_1", ...aiToolErrorPayloadSlice(calls) },
		{ rowSchema: aiToolErrorPayloadsRowSchema },
	)

	it("seeks the named spans and nothing else", () => {
		expect(compiled.tenantScope).toBe("single-tenant")
		// A primary-key seek on `(OrgId, TraceId, SpanId)`: the tuple list is the
		// occurrences the modal already has, so the read cannot widen with the
		// window the reader picked.
		expect(compiled.sql).toContain(
			"(trace_detail_spans.TraceId, trace_detail_spans.SpanId) IN (tuple('t2', 's2'), tuple('t1', 's1'))",
		)
		expect(compiled.sql).not.toContain("IN (SELECT")
	})

	it("bounds the read by the occurrences' own extent, unpadded", () => {
		// The index copies `Timestamp` from the span verbatim, so a call is inside
		// its own bounds by construction and a pad would only buy partitions.
		expect(aiToolErrorPayloadSlice(calls)).toEqual({
			sliceStart: "2026-08-18 01:00:00.000000000",
			sliceEnd: "2026-08-18 04:00:00.000000000",
		})
		expect(compiled.sql).toContain("Timestamp >= '2026-08-18 01:00:00.000000000'")
		expect(compiled.sql).toContain("Timestamp <= '2026-08-18 04:00:00.000000000'")
		// Never the caller's window, which is what the old shape read over.
		expect(compiled.sql).not.toContain("2026-08-19 23:59:59")
	})

	it("truncates payloads by codepoint and reports their size in bytes", () => {
		// `left` counts BYTES and would cut a multi-byte codepoint in half.
		expect(compiled.sql).not.toContain("left(")
		expect(compiled.sql).toContain("leftUTF8(")
		expect(compiled.sql).toContain("AS argumentsBytes")
		expect(compiled.sql).toContain("AS resultBytes")
		expect(
			decodeRows(compiled, [
				{
					traceId: "t1",
					spanId: "s1",
					statusCode: "Error",
					arguments: "{}",
					argumentsBytes: "2",
					result: "",
					resultBytes: 0,
				},
			])[0],
		).toMatchObject({ argumentsBytes: 2, resultBytes: 0 })
	})
})

describe("aiToolDescriptionQuery", () => {
	const compiled = compileUnsafe(aiToolDescriptionQuery(), descriptionParams, {
		rowSchema: aiToolDescriptionRowSchema,
	})

	it("answers off the index, from the tool's own rows", () => {
		expect(compiled.tenantScope).toBe("single-tenant")
		// One level, one table. This read ranked a hundred calls and then seeked
		// the span table for each, and it was what the page waited on.
		expect(orgPredicateCount(compiled.sql)).toBe(1)
		expect(compiled.sql).not.toContain("trace_detail_spans")
		expect(compiled.sql).toContain("FROM ai_trace_index")
		expect(compiled.sql).toContain("IsToolCall = 1")
		expect(compiled.sql).toContain("ToolName = 'search_traces'")
	})

	it("keeps the latest description a call actually stamped", () => {
		expect(compiled.sql).toContain("argMax(ToolDescription, Timestamp) AS description")
		// Rows materialized before migration 0032 read '', and so does a call
		// whose framework stamps nothing — without this the `argMax` would answer
		// '' for a tool whose most recent call is one of them.
		expect(compiled.sql).toContain("ToolDescription != ''")
		expect(decodeRows(compiled, [{ description: "Search traces." }])).toEqual([
			{ description: "Search traces." },
		])
	})
})
