import { describe, expect, it } from "vitest"
import { Array as Arr, Effect } from "effect"
import { compileUnionUnsafe, compileUnsafe, type CompiledQuery } from "@maple-dev/effect-clickhouse"
import {
	aiToolDescriptionQuery,
	aiToolDescriptionRowSchema,
	aiToolErrorBreakdownQuery,
	aiToolErrorBreakdownRowSchema,
	aiToolErrorOccurrencesQuery,
	aiToolErrorOccurrencesRowSchema,
	aiToolErrorPayload,
	aiToolErrorPayloadSlice,
	aiToolErrorPayloadsQuery,
	aiToolErrorPayloadsRowSchema,
	aiToolErrorSessionsQuery,
	aiToolErrorSessionsRowSchema,
	aiToolErrorVariantsQuery,
	aiToolErrorVariantsRowSchema,
	aiToolErrorsQuery,
	aiToolErrorsRowSchema,
	aiToolsBreakdownsQuery,
	aiToolsSeriesKind,
	aiToolsSeriesQuery,
	aiToolsTotalsQuery,
	AI_TOOLS_BREAKDOWN_LIMIT,
	AI_TOOLS_SERIES_MAX_KEYS,
	AI_TOOL_ERROR_ATTRIBUTE_MAX,
	AI_TOOL_ERROR_PAYLOAD_MAX,
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
const MODEL_EXPR =
	"if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel)"

/** The sessions list's key, resolved per trace — the same expression
 *  `aiSessionPageQuery` groups on, so a row here links to a row there. */
const SESSION_KEY =
	"if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId)"

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

	it("counts the sessions list's population in the window's Sessions tile", () => {
		const { sql } = compileUnionUnsafe(aiToolsTotalsQuery({}, ["window"]), totalsParams)

		// The same per-trace rule the list applies, or the tile counts sessions
		// the list does not show.
		expect(sql).toContain(
			"HAVING countIf((((SessionId != '' OR IsLlmCall = 1) OR IsToolCall = 1) OR AgentName != '')) > 0",
		)
		expect(sql).toContain(") AS window_traces")
	})

	it("scopes every level that reads the table to the org", () => {
		// Two reads of `ai_trace_index` per aggregation level without a model
		// filter: the tool calls and the trace facts. A model filter adds the
		// parent-model level, and the series a second copy for its top-N ranking.
		expect(orgPredicateCount(compileUnsafe(aiToolsBreakdownsQuery(), params).sql)).toBe(2)
		expect(orgPredicateCount(compileUnsafe(aiToolsBreakdownsQuery({ model: "gpt-5" }), params).sql)).toBe(
			3,
		)
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
		// model, keeps the default, as do the modal's sessions and variants.
		for (const sql of [
			compileUnsafe(aiToolErrorBreakdownQuery(errorSelection), params).sql,
			compileUnsafe(aiToolErrorOccurrencesQuery(errorSelection), params).sql,
		]) {
			expect(sql).toContain("LEFT JOIN")
			expect(sql).toContain(`${MODEL_EXPR} AS modelName`)
		}
		for (const sql of [
			compileUnsafe(aiToolErrorsQuery(errorSelection), params).sql,
			compileUnsafe(aiToolErrorSessionsQuery(errorSelection), params).sql,
			compileUnsafe(aiToolErrorVariantsQuery(errorSelection), params).sql,
		]) {
			expect(sql).not.toContain("parentModel")
		}
	})

	it("applies the selection where each half of it can be applied", () => {
		const { sql } = compileUnsafe(
			aiToolsSeriesQuery({
				tool: "search_traces",
				model: "gpt-5",
				service: "agent",
				env: "production",
			}),
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
		expect(compileUnsafe(aiToolsSeriesQuery({ tool: "t" }), params).sql).toContain(
			"if(modelName IN (SELECT",
		)
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
		const listed = compileUnionUnsafe(aiToolsTotalsQuery({}, ["window", "current"]), totalsParams).sql
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
	/** A fingerprint past 2^53, which is why every read carries it as a string. */
	const FINGERPRINT = "12345678901234567890"
	const group = { ...errorSelection, fingerprint: FINGERPRINT } as const

	it("reads the index alone — the failure's text and fingerprint are columns", () => {
		for (const sql of [
			compileUnsafe(aiToolErrorsQuery({ ...errorSelection, model: "gpt-5", service: "agent" }), params)
				.sql,
			compileUnsafe(aiToolErrorOccurrencesQuery({ ...group, model: "gpt-5", service: "agent" }), params)
				.sql,
			compileUnsafe(aiToolErrorSessionsQuery(group), params).sql,
			compileUnsafe(aiToolErrorVariantsQuery(group), params).sql,
			compileUnsafe(aiToolErrorBreakdownQuery(group), params).sql,
		]) {
			// Migration 0032. Before it the failure reads seeked `trace_detail_spans`
			// inside the traces the index named, which costs by the partitions the
			// window spreads over — seconds to tens of seconds on a week.
			expect(sql).not.toContain("trace_detail_spans")
			expect(sql).not.toContain("SpanAttributes")
			expect(sql).toContain("ai_trace_index.ToolName = 'search_traces'")
			// Selected through `toString`: a UInt64 past 2^53 is not a JSON number.
			expect(sql).toContain("toString(ai_trace_index.ErrorFingerprint) AS fingerprint")
		}
		expect(
			compileUnsafe(aiToolErrorsQuery({ ...errorSelection, env: "production" }), params).sql,
		).toContain("ai_trace_index.DeploymentEnv = 'production'")
	})

	it("groups the failures by fingerprint and labels each with its latest type and text", () => {
		const { sql } = compileUnsafe(aiToolErrorsQuery(errorSelection), params)

		// The text a fingerprint hashes: the failed call's result, else its status.
		expect(sql).toContain(
			"coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage",
		)
		// Aggregates are never aliased to their own input's name.
		expect(sql).toContain("argMax(callErrorType, ts) AS errorType")
		expect(sql).toContain("argMax(failureMessage, ts) AS message")
		expect(sql).toContain("uniqExact(failureMessage) AS variants")
		expect(sql).toContain("uniqExact(sessionKey) AS sessions")
		expect(sql).toContain("GROUP BY fingerprint")
		expect(sql).toContain("ORDER BY calls DESC, fingerprint ASC")
	})

	it("numbers every call of the selection, then keeps the failures", () => {
		// The toolbar's failing-only is dropped: `callsSince` counts the calls
		// newer than a group's latest failure, and the successes are most of them.
		const { sql } = compileUnsafe(aiToolErrorsQuery({ ...errorSelection, failingOnly: true }), params)

		expect(sql).not.toContain("ai_trace_index.IsError = 1")
		expect(sql).toContain("row_number() OVER (ORDER BY ts DESC, spanId DESC) - 1 AS newerCalls")
		expect(sql).toContain("min(newerCalls) AS callsSince")
		// The failure filter is the outer level's, above the numbering.
		expect(sql).toContain("WHERE isError = 1")
		expect(sql.indexOf("WHERE isError = 1")).toBeGreaterThan(sql.indexOf("row_number()"))
	})

	it("counts each group's failures per bucket of the caller's interval", () => {
		const { sql } = compileUnsafe(aiToolErrorsQuery(errorSelection), params)

		expect(sql).toContain("toStartOfInterval(ts, INTERVAL 300 SECOND)")
		expect(sql).toContain("sumMap(map(bucket, toUInt64(1))) AS trend")
	})

	it("narrows every detail read to the group, and only the samples to a session or a variant", () => {
		const narrowed = { ...group, session: "sess_1", variant: "" }
		for (const sql of [
			compileUnsafe(aiToolErrorSessionsQuery(narrowed), params).sql,
			compileUnsafe(aiToolErrorVariantsQuery(narrowed), params).sql,
			compileUnsafe(aiToolErrorBreakdownQuery(narrowed), params).sql,
		]) {
			expect(sql).toContain(`fingerprint = '${FINGERPRINT}'`)
			// The lists a reader picks a session or a variant FROM stay whole.
			expect(sql).not.toContain("'sess_1'")
			expect(sql).not.toContain("failureMessage = ''")
		}

		const { sql } = compileUnsafe(aiToolErrorOccurrencesQuery(narrowed), params)
		expect(sql).toContain(`fingerprint = '${FINGERPRINT}'`)
		expect(sql).toContain("sessionKey = 'sess_1'")
		// `''` is a real raw text — a failure that said nothing — so it narrows.
		expect(sql).toContain("failureMessage = ''")
		expect(sql).toContain("ORDER BY timestamp DESC, spanId DESC")
		expect(sql).toContain(`LIMIT ${AI_TOOL_OCCURRENCES_LIMIT}`)
	})

	it("pages the samples strictly past the previous page's last row", () => {
		const { sql } = compileUnsafe(
			aiToolErrorOccurrencesQuery({
				...group,
				before: { timestamp: "2026-08-18 01:00:00.000000000", spanId: "s9" },
			}),
			params,
		)

		expect(sql).toContain(
			"(ts < '2026-08-18 01:00:00.000000000' OR (ts = '2026-08-18 01:00:00.000000000' AND spanId < 's9'))",
		)
	})

	it("decodes each read through its declared row schema", () => {
		const errors = compileUnsafe(aiToolErrorsQuery(errorSelection), params, {
			rowSchema: aiToolErrorsRowSchema,
		})
		expect(
			decodeRows(errors, [
				{
					fingerprint: FINGERPRINT,
					errorType: "tool_error",
					message: '{"result":"Invalid tool input: Missing key\\n  at [\\"claim\\"]"}',
					calls: 4,
					sessions: 2,
					variants: 1,
					firstSeen: "2026-08-18 00:00:00",
					lastSeen: "2026-08-18 01:00:00",
					callsSince: "281",
					// Quoted on a gateway that refuses the 64-bit setting, which is
					// why every count here is `CHNumber` and not `Schema.Number`.
					trend: { "2026-08-18T00:00:00.000Z": "3", "2026-08-18T00:05:00.000Z": 1 },
				},
			])[0],
		).toMatchObject({
			calls: 4,
			callsSince: 281,
			trend: { "2026-08-18T00:00:00.000Z": 3, "2026-08-18T00:05:00.000Z": 1 },
		})

		const sessions = compileUnsafe(aiToolErrorSessionsQuery(group), params, {
			rowSchema: aiToolErrorSessionsRowSchema,
		})
		expect(
			decodeRows(sessions, [
				{
					sessionId: "s1",
					vendorId: "eve",
					agentName: "agent",
					service: "maple-investigations",
					hits: "7",
					lastSeen: "2026-08-18 01:00:00",
				},
			])[0],
		).toMatchObject({ hits: 7 })

		const variants = compileUnsafe(aiToolErrorVariantsQuery(group), params, {
			rowSchema: aiToolErrorVariantsRowSchema,
		})
		expect(
			decodeRows(variants, [{ message: "at [0]", calls: "4", lastSeen: "2026-08-18 01:00:00" }])[0],
		).toMatchObject({ calls: 4 })

		const breakdown = compileUnsafe(aiToolErrorBreakdownQuery(group), params, {
			rowSchema: aiToolErrorBreakdownRowSchema,
		})
		expect(decodeRows(breakdown, [{ model: "gpt-5", service: "agent", calls: "8" }])[0]).toMatchObject({
			calls: 8,
		})

		const occurrences = compileUnsafe(aiToolErrorOccurrencesQuery(group), params, {
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
					service: "agent",
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

	it("reads the attributes the session page decodes, not a payload of its own", () => {
		// Which attribute holds the arguments is the integrations' call, so the
		// read hands back the same projection the session span read does.
		expect(compiled.sql).toContain("mapFilter((k, v) ->")
		expect(compiled.sql).toContain("'input.value'")
		expect(compiled.sql).toContain("'tool.parameters'")
		expect(compiled.sql).toContain("AS spanAttributes")
		expect(compiled.sql).not.toContain("coalesce(")
	})

	it("cuts every value in SQL and reports the true size of the ones it cut", () => {
		expect(compiled.sql).toContain(
			`mapApply((k, v) -> (k, leftUTF8(v, ${AI_TOOL_ERROR_ATTRIBUTE_MAX})), mapFilter(`,
		)
		expect(compiled.sql).toContain(
			`mapApply((k, v) -> (k, length(v)), mapFilter((k, v) -> lengthUTF8(v) > ${AI_TOOL_ERROR_ATTRIBUTE_MAX}, mapFilter(`,
		)
		expect(compiled.sql).toContain("AS cutAttributeBytes")
		expect(
			decodeRows(compiled, [
				{
					traceId: "t1",
					spanId: "s1",
					statusCode: "Error",
					spanAttributes: { "input.value": "{}" },
					// UInt64 arrives quoted under FORMAT JSON.
					cutAttributeBytes: { "output.value": "40000" },
				},
			])[0]?.cutAttributeBytes,
		).toEqual({ "output.value": 40_000 })
	})
})

describe("aiToolErrorPayload", () => {
	const payload = (
		spanAttributes: Record<string, string>,
		cutAttributeBytes: Record<string, number> = {},
	) =>
		aiToolErrorPayload({
			traceId: "t1",
			spanId: "s1",
			statusCode: "Error",
			spanAttributes,
			cutAttributeBytes,
		})

	// `update_seat` as the OpenAI Agents SDK's Python OpenInference instrumentor
	// emitted it in production: the GenAI dual-write put the parameter schema in
	// `gen_ai.tool.call.arguments` (session `verify-oa-py-nofix1-1`) where the
	// baseline run (`verify-oa-py-base-1`) had the real arguments.
	const UPDATE_SEAT_SCHEMA =
		'{"properties": {"confirmation_number": {"description": "The confirmation number for the flight.", "title": "Confirmation Number", "type": "string"}, "new_seat": {"description": "The new seat to update to.", "title": "New Seat", "type": "string"}}, "required": ["confirmation_number", "new_seat"], "title": "update_seat_args", "type": "object", "additionalProperties": false}'
	const UPDATE_SEAT_ARGS = '{"confirmation_number":"ABC123","new_seat":"14C"}'
	const UPDATE_SEAT_ERROR =
		"An error occurred while running the tool. Please try again. Error: Seat 14C is temporarily locked, retry once"
	const updateSeat = (dualWrittenArguments: string) => ({
		"maple_ai.vendor.id": "openai_agents_sdk",
		"openinference.span.kind": "TOOL",
		"tool.name": "update_seat",
		"gen_ai.tool.name": "update_seat",
		"tool.parameters": UPDATE_SEAT_SCHEMA,
		"gen_ai.tool.call.arguments": dualWrittenArguments,
		"input.value": UPDATE_SEAT_ARGS,
		"output.value": UPDATE_SEAT_ERROR,
		"gen_ai.tool.call.result": UPDATE_SEAT_ERROR,
	})

	it("shows an OpenInference tool's arguments where the dual-write copied its schema", () => {
		expect(payload(updateSeat(UPDATE_SEAT_SCHEMA))).toMatchObject({
			arguments: UPDATE_SEAT_ARGS,
			argumentsBytes: UPDATE_SEAT_ARGS.length,
			result: UPDATE_SEAT_ERROR,
		})
		// The run whose dual-write carried the arguments reads the same.
		expect(payload(updateSeat(UPDATE_SEAT_ARGS)).arguments).toBe(UPDATE_SEAT_ARGS)
	})

	// LlamaIndex `get_weather`: with the GenAI dual-write on (`verify-li-sem1-1`)
	// the arguments slot holds the schema, with it off (`verify-li-sem0-1`) it is
	// empty, and `input.value` has the call either way.
	const WEATHER_SCHEMA =
		'{"properties": {"city": {"title": "City", "type": "string"}, "unit": {"title": "Unit", "type": "string"}}, "required": ["city", "unit"], "type": "object"}'
	const WEATHER_OUTPUT =
		'{"blocks":[{"text":"Weather in Berlin: 18 degrees celsius, light rain."}],"tool_name":"get_weather","raw_input":{"args":[],"kwargs":{"city":"Berlin","unit":"celsius"}},"raw_output":"Weather in Berlin: 18 degrees celsius, light rain.","is_error":false}'
	const getWeather = (dualWrite: Record<string, string>) => ({
		"maple_ai.vendor.id": "llamaindex",
		"openinference.span.kind": "TOOL",
		"tool.name": "get_weather",
		"tool.parameters": WEATHER_SCHEMA,
		"input.value": '{"kwargs": {"city": "Berlin", "unit": "celsius"}}',
		"output.value": WEATHER_OUTPUT,
		...dualWrite,
	})

	it("reads a LlamaIndex tool's input whether or not the dual-write ran", () => {
		const withDualWrite = payload(
			getWeather({
				"gen_ai.tool.call.arguments": WEATHER_SCHEMA,
				"gen_ai.tool.call.result": WEATHER_OUTPUT,
			}),
		)
		const without = payload(getWeather({}))
		// Re-serialised from the decoded value, as the session page renders it.
		const args = '{"kwargs":{"city":"Berlin","unit":"celsius"}}'
		expect(withDualWrite.arguments).toBe(args)
		expect(without.arguments).toBe(args)
		expect(without.result).toBe(WEATHER_OUTPUT)
	})

	it("unwraps a LangChain ToolMessage result to what the tool returned", () => {
		expect(
			payload({
				"gen_ai.tool.name": "get_weather",
				"gen_ai.tool.call.result":
					'{"type": "tool", "data": {"content": "{\\"city\\": \\"Berlin\\"}", "type": "tool", "name": "get_weather", "tool_call_id": "call_1", "status": "success"}}',
			}).result,
		).toBe('{"city": "Berlin"}')
	})

	it("truncates by codepoint and reports the full size in bytes", () => {
		const long = `"${"é".repeat(AI_TOOL_ERROR_PAYLOAD_MAX + 10)}"`
		const cut = payload({ "gen_ai.tool.call.arguments": "{}", "gen_ai.tool.call.result": long })
		expect(cut).toMatchObject({ arguments: "{}", argumentsBytes: 2 })
		// A JSON string decodes to its text; every `é` is two bytes.
		expect(Array.from(cut.result)).toHaveLength(AI_TOOL_ERROR_PAYLOAD_MAX)
		expect(cut.resultBytes).toBe((AI_TOOL_ERROR_PAYLOAD_MAX + 10) * 2)
		expect(payload({})).toMatchObject({ arguments: "", argumentsBytes: 0, result: "", resultBytes: 0 })
	})

	it("shows a value the read cut as its raw text, at its true size", () => {
		// As the read returns a 40 KB JSON result: cut mid-document, so it no
		// longer parses.
		const whole = JSON.stringify({ rows: "x".repeat(40_000) })
		const cut = whole.slice(0, AI_TOOL_ERROR_ATTRIBUTE_MAX)
		const shown = payload(
			{ "gen_ai.tool.call.arguments": "{}", "gen_ai.tool.call.result": cut },
			{ "gen_ai.tool.call.result": whole.length },
		)
		expect(shown).toMatchObject({ arguments: "{}", argumentsBytes: 2, resultBytes: whole.length })
		expect(shown.result).toBe(cut.slice(0, AI_TOOL_ERROR_PAYLOAD_MAX))
	})

	it("still swaps an OpenInference schema for the arguments when both are cut", () => {
		// The schema and its dual-written copy are cut to the same prefix, so
		// they still compare equal and `input.value` still wins.
		const schema = JSON.stringify({
			properties: { seat: { description: "d".repeat(AI_TOOL_ERROR_ATTRIBUTE_MAX) } },
		})
		const cut = schema.slice(0, AI_TOOL_ERROR_ATTRIBUTE_MAX)
		expect(
			payload(
				{ ...updateSeat(cut), "tool.parameters": cut },
				{ "tool.parameters": schema.length, "gen_ai.tool.call.arguments": schema.length },
			),
		).toMatchObject({ arguments: UPDATE_SEAT_ARGS, argumentsBytes: UPDATE_SEAT_ARGS.length })
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
