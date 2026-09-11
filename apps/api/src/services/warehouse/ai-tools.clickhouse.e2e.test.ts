// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Agent Sessions › Tools, against real rows.
//
// The tools page's reads all hang off two derivations the compiled SQL
// cannot prove on its own:
//
//   - the MODEL of a tool call, which is never on the tool row. It comes from
//     the parent model call's index row where there is one, and from the
//     trace's own model where there is not — a LEFT JOIN and an INNER JOIN
//     whose behaviour on a miss depends on `join_use_nulls`, a server setting.
//     A SQL-text test cannot tell a working fallback from one that silently
//     answers '' for every vendor whose tool spans hang off a workflow node.
//
//   - the SESSION of a tool call, which is `max(SessionId)` per TRACE. Keyed
//     per row instead — which is what a naive read of the column does — nearly
//     every tool call becomes its own `trace:` session and every session count
//     on the page is wrong by an order of magnitude, behind a healthy 200.
//
// So this suite seeds spans into `traces`, lets the real migration chain's
// `ai_trace_index_mv` materialize them, and runs the real compiled builders
// over the result — one trace per attribution path, and one foreign org to
// prove the scope.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { compileUnionUnsafe, compileUnsafe } from "@maple-dev/effect-clickhouse"
import { MAPLE_AI_SESSION_ID_ATTR, MAPLE_AI_VENDOR_ID_ATTR } from "@maple/domain/gen-ai"
import * as Integrations from "@maple/query-engine-integrations"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_ai_tools_e2e")
const ORG_ID = "org_ai_tools_e2e"
const FOREIGN_ORG_ID = "org_ai_tools_e2e_other"

// Anchored to now: `traces` and `ai_trace_index` both enforce a 30-day TTL at
// insert, so a hardcoded date would one day drop every seed and leave the suite
// comparing nothing to nothing.
const HOUR_MS = 3_600_000
const BASE_MS = Math.floor((Date.now() - 2 * HOUR_MS) / 1000) * 1000

/** The second bucket, half an hour on — what proves the series buckets at all. */
const LATER_MS = BASE_MS + 1_800_000

const SESSION_ID = `${ORG_ID}:inv-tools-1`
/** Parent-model attribution: the tool hangs off the chat span. */
const TRACE_PARENT = "aitoolse2e0000000000000000000001"
/** Trace-model fallback: the tool hangs off the turn span, which has no model. */
const TRACE_FALLBACK = "aitoolse2e0000000000000000000002"
/** Neither: a trace with no model-bearing span at all. */
const TRACE_UNATTRIBUTED = "aitoolse2e0000000000000000000003"
const TRACE_FOREIGN = "aitoolse2e0000000000000000000004"

const GPT = "gpt-5"
const CLAUDE = "claude-sonnet-5"

interface SeedSpan {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId?: string
	readonly name: string
	readonly ms: number
	readonly durationNs: number
	readonly status: string
	readonly attrs: Readonly<Record<string, string>>
}

const agentSpan = (attrs: Readonly<Record<string, string>>) => ({
	[MAPLE_AI_VENDOR_ID_ATTR]: "eve",
	...attrs,
})

const SEED_SPANS: ReadonlyArray<SeedSpan> = [
	// TRACE_PARENT — the ordinary shape. The turn span carries the session id,
	// the chat span beneath it carries the model, and both tool calls hang off
	// one of the two.
	{
		traceId: TRACE_PARENT,
		spanId: "tools-turn-1",
		name: "invoke_agent slack-agent",
		ms: BASE_MS,
		durationNs: 9_000_000,
		status: "Ok",
		attrs: agentSpan({
			[MAPLE_AI_SESSION_ID_ATTR]: SESSION_ID,
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": "slack-agent",
		}),
	},
	{
		traceId: TRACE_PARENT,
		spanId: "tools-chat-1",
		parentSpanId: "tools-turn-1",
		name: "chat gpt-5",
		ms: BASE_MS + 100,
		durationNs: 4_000_000,
		status: "Ok",
		attrs: agentSpan({ "gen_ai.operation.name": "chat", "gen_ai.response.model": GPT }),
	},
	// Parent IS the model call: attributed to gpt-5 by the join.
	{
		traceId: TRACE_PARENT,
		spanId: "tools-tool-1",
		parentSpanId: "tools-chat-1",
		name: "execute_tool search_traces",
		ms: BASE_MS + 200,
		durationNs: 1_000_000,
		status: "Ok",
		attrs: agentSpan({
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "search_traces",
			"gen_ai.tool.description": "Search traces.",
			"gen_ai.agent.name": "slack-agent",
		}),
	},
	// Parent is the TURN span, which carries no model — so this one can only be
	// attributed by the trace fallback, and it must still land on gpt-5. It also
	// failed, which is the page's one error.
	{
		traceId: TRACE_PARENT,
		spanId: "tools-tool-2",
		parentSpanId: "tools-turn-1",
		name: "execute_tool run_sql",
		ms: BASE_MS + 300,
		durationNs: 5_000_000,
		status: "Error",
		attrs: agentSpan({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "run_sql" }),
	},
	// TRACE_FALLBACK — no session id anywhere, so the whole trace is one
	// `trace:` session, and its tool call is attributed through its parent.
	{
		traceId: TRACE_FALLBACK,
		spanId: "tools-chat-2",
		name: "chat claude-sonnet-5",
		ms: BASE_MS + 400,
		durationNs: 6_000_000,
		status: "Ok",
		attrs: agentSpan({ "gen_ai.operation.name": "chat", "gen_ai.response.model": CLAUDE }),
	},
	{
		traceId: TRACE_FALLBACK,
		spanId: "tools-tool-3",
		parentSpanId: "tools-chat-2",
		name: "execute_tool search_traces",
		ms: BASE_MS + 500,
		durationNs: 3_000_000,
		status: "Ok",
		attrs: agentSpan({
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "search_traces",
			"gen_ai.tool.description": "Search traces by attribute.",
		}),
	},
	// TRACE_UNATTRIBUTED — a tool call with no model anywhere in its trace, at a
	// zero duration (the structured-output pseudo-tool shape). It is a call: it
	// keys under '' and it counts.
	{
		traceId: TRACE_UNATTRIBUTED,
		spanId: "tools-tool-4",
		name: "execute_tool search_traces",
		ms: LATER_MS,
		durationNs: 0,
		status: "Ok",
		attrs: agentSpan({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search_traces" }),
	},
]

/** Another org's tool call, in the same window — the reads must never see it. */
const FOREIGN_SPAN: SeedSpan = {
	traceId: TRACE_FOREIGN,
	spanId: "tools-tool-foreign",
	name: "execute_tool search_traces",
	ms: BASE_MS + 600,
	durationNs: 7_000_000,
	status: "Ok",
	attrs: agentSpan({
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": "search_traces",
		"gen_ai.tool.description": "Another org's search.",
	}),
}

const quote = (value: string): string => `'${value.replaceAll("'", "\\'")}'`
const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 23)
const chMap = (attrs: Readonly<Record<string, string>>): string =>
	`map(${Object.entries(attrs)
		.flatMap(([key, value]) => [quote(key), quote(value)])
		.join(", ")})`

const seed = async (): Promise<void> => {
	const rows = [
		...SEED_SPANS.map((span) => [ORG_ID, span] as const),
		[FOREIGN_ORG_ID, FOREIGN_SPAN] as const,
	]
		.map(
			([orgId, span]) =>
				`(${quote(orgId)}, ${quote(chDateTime(span.ms))}, ${quote(span.traceId)}, ${quote(span.spanId)}, ${quote(span.parentSpanId ?? "")}, ${quote(span.name)}, 'Internal', 'agent-service', ${span.durationNs}, ${quote(span.status)}, 1, ${chMap(span.attrs)}, ${chMap({ "deployment.environment.name": "production" })})`,
		)
		.join("\n,")

	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, SpanAttributes, ResourceAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

const window = {
	orgId: ORG_ID,
	startTime: chDateTime(BASE_MS - HOUR_MS),
	endTime: chDateTime(BASE_MS + HOUR_MS),
}

/** The comparison window the totals route computes: equal length, ending where
 *  the caller's begins. Nothing was seeded into it. */
const compareWindow = {
	...window,
	prevStartTime: chDateTime(BASE_MS - 3 * HOUR_MS),
	prevEndTime: chDateTime(BASE_MS - HOUR_MS),
}

describe.skipIf(!clickhouseE2eEnabled)("agent tools reads", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("attributes every tool call's session, and nobody else's", async () => {
		const compiled = compileUnsafe(Integrations.aiToolsBreakdownsQuery(), window)
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))

		// Three sessions invoked `search_traces` once each; `run_sql` ran once and
		// failed. The foreign org's identical tool call is in neither.
		assert.deepStrictEqual(
			rows.map((row) => ({
				key: row.key,
				calls: row.calls,
				sessions: row.sessions,
				errors: row.errors,
			})),
			[
				{ key: "search_traces", calls: 3, sessions: 3, errors: 0 },
				{ key: "run_sql", calls: 1, sessions: 1, errors: 1 },
			],
		)
	})

	it("merges every key inside the query when the caller asks for no split", async () => {
		// The tool detail page's read. Merging a per-model split on the client
		// instead would sum sessions across models and average their quantiles —
		// `search_traces` ran once in each of three sessions under two models.
		const compiled = compileUnsafe(
			Integrations.aiToolsSeriesQuery({ tool: "search_traces", split: "none" }),
			{ ...window, bucketSeconds: 86_400 },
		)
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))

		assert.strictEqual(rows.length, 1)
		assert.deepStrictEqual(
			{ seriesKey: rows[0]?.seriesKey, calls: rows[0]?.calls, sessions: rows[0]?.sessions },
			{ seriesKey: "", calls: 3, sessions: 3 },
		)
	})

	it("buckets the series and keys it by the dimension the selection implies", async () => {
		const compiled = compileUnsafe(Integrations.aiToolsSeriesQuery(), { ...window, bucketSeconds: 300 })
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))

		// Two buckets: three calls in the first, the zero-duration one half an
		// hour later in its own. Sessions are counted per bucket and per key.
		assert.deepStrictEqual(
			rows.map((row) => ({ seriesKey: row.seriesKey, calls: row.calls, sessions: row.sessions })),
			[
				{ seriesKey: "search_traces", calls: 2, sessions: 2 },
				{ seriesKey: "run_sql", calls: 1, sessions: 1 },
				{ seriesKey: "search_traces", calls: 1, sessions: 1 },
			],
		)
		// ISO-8601 with a literal Z, fixed width — so the strings sort as the
		// instants do, which is what lets the client plot them without parsing.
		assert.isTrue(rows[0]!.bucket < rows[2]!.bucket, `${rows[0]!.bucket} < ${rows[2]!.bucket}`)

		// A tool selected and no model: the same calls, now split by the model
		// each was attributed to.
		const perModel = compileUnsafe(Integrations.aiToolsSeriesQuery({ tool: "search_traces" }), {
			...window,
			bucketSeconds: 3_600,
		})
		const modelRows = Effect.runSync(perModel.decodeRows(await runJson(perModel.sql)))
		assert.deepStrictEqual(
			[...modelRows].map((row) => row.seriesKey).sort(),
			["", CLAUDE, GPT],
		)
	})

	it("measures the window and the one before it in one read", async () => {
		const compiled = compileUnionUnsafe(Integrations.aiToolsTotalsQuery(), compareWindow)
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))

		const period = (name: string) => rows.find((row) => row.period === name)
		// Four tool calls across three sessions, one of them failed.
		assert.deepStrictEqual(
			{
				calls: period("current")?.calls,
				sessions: period("current")?.sessions,
				errors: period("current")?.errors,
			},
			{ calls: 4, sessions: 3, errors: 1 },
		)
		// Nanoseconds, undivided: the four calls took 0, 1ms, 3ms and 5ms, and
		// `quantile` interpolates — the median lands between the two middle
		// samples, and p95 just short of the slowest call rather than on it.
		assert.strictEqual(period("current")?.p50, 2_000_000)
		assert.closeTo(period("current")!.p95, 4_700_000, 1)
		// An empty window returns a row of zeros, not NULL percentiles the row
		// schema would refuse.
		assert.deepStrictEqual(
			{ calls: period("previous")?.calls, p50: period("previous")?.p50 },
			{ calls: 0, p50: 0 },
		)
	})

	it("narrows every read by the toolbar's search and failing-only", async () => {
		const toolCalls = async (opts: Parameters<typeof Integrations.aiToolsBreakdownsQuery>[0]) => {
			const compiled = compileUnsafe(Integrations.aiToolsBreakdownsQuery(opts), window)
			const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))
			return rows.map((row) => ({ key: row.key, calls: row.calls }))
		}

		// A substring, case-insensitively — the toolbar is a search box, not a
		// facet, so `RUN` finds `run_sql`.
		assert.deepStrictEqual(await toolCalls({ search: "RUN" }), [{ key: "run_sql", calls: 1 }])
		// The needle's own `_` is a literal. It matches the tool whose name
		// contains it, and `%` matches nothing rather than everything between —
		// which is exactly what an unescaped needle would do here.
		assert.deepStrictEqual(await toolCalls({ search: "run_sql" }), [{ key: "run_sql", calls: 1 }])
		assert.deepStrictEqual(await toolCalls({ search: "run%sql" }), [])

		// The one failed call of the window, and it is the same call.
		assert.deepStrictEqual(await toolCalls({ failingOnly: true }), [{ key: "run_sql", calls: 1 }])

		// The tiles read the same narrowed population — the whole point of these
		// being server-side predicates rather than a filter over rows in hand.
		const totals = compileUnionUnsafe(
			Integrations.aiToolsTotalsQuery({ failingOnly: true }),
			compareWindow,
		)
		const totalRows = Effect.runSync(totals.decodeRows(await runJson(totals.sql)))
		const current = totalRows.find((row) => row.period === "current")
		assert.deepStrictEqual({ calls: current?.calls, errors: current?.errors }, { calls: 1, errors: 1 })

	})

	it("selects by the model a tool call was attributed to, not by a column", async () => {
		// The decisive case: `run_sql` has no model on its own row AND none on its
		// parent. It is selected here only because the trace fallback put it on
		// gpt-5 — a filter pushed onto `ai_trace_index.Model` would return nothing.
		const compiled = compileUnsafe(Integrations.aiToolsBreakdownsQuery({ model: GPT }), window)
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))

		assert.deepStrictEqual(
			rows.map((row) => ({ key: row.key, calls: row.calls })),
			[
				{ key: "run_sql", calls: 1 },
				{ key: "search_traces", calls: 1 },
			],
		)
	})

	it("reads a tool's latest non-empty description, and nobody else's", async () => {
		const describeTool = async (toolName: string) => {
			const compiled = compileUnsafe(
				Integrations.aiToolDescriptionQuery(),
				{ ...window, toolName },
				{ rowSchema: Integrations.aiToolDescriptionRowSchema },
			)
			return Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))
		}

		// The latest `search_traces` call stamps none and an older one stamps an
		// older text; the foreign org's is newer than both and must not win.
		assert.deepStrictEqual(await describeTool("search_traces"), [
			{ description: "Search traces by attribute." },
		])
		// No call stamped one: a single `''` row, which the route leaves out.
		assert.deepStrictEqual(await describeTool("run_sql"), [{ description: "" }])
	})
})
