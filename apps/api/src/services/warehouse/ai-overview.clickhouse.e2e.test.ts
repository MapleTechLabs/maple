// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Agent Sessions › Overview, against real rows.
//
// The overview's whole contract is that its numbers reconcile with the
// sessions LIST over the same window, and nothing about that can be proved
// from SQL text:
//
//   - the SESSION a row belongs to is `max(SessionId)` per TRACE. Keyed per
//     row instead, every span that carries no session id becomes its own
//     session and every count is wrong by an order of magnitude behind a
//     healthy 200.
//   - USAGE is netted. A wrapper that rolls up its children's tokens, a
//     gateway that files a second trace of the same call under the same
//     session, and a provider retry beneath the call each have to count once,
//     and each of those three is an array pass over real rows.
//   - the buckets have to SUM to the totals, which is a statement about where
//     a session that ran across a bucket boundary lands.
//
// So this suite seeds spans into `traces`, lets the real migration chain's
// `ai_trace_index_mv` materialize them, and runs the real compiled builders
// over the result — beside `aiSessionPageQuery` over the same window, which is
// what the numbers are checked against. It reads with
// `use_variant_as_common_type = 0`, the setting managed Tinybird runs, so a
// `UNION ALL` branch whose types only agree on a modern analyzer fails here.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { compileUnionUnsafe, compileUnsafe } from "@maple-dev/effect-clickhouse"
import { MAPLE_AI_SESSION_ID_ATTR, MAPLE_AI_VENDOR_ID_ATTR } from "@maple/domain/gen-ai"
import * as Integrations from "@maple/query-engine-integrations"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	ANALYZER_STRICTNESS,
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_ai_overview_e2e")
const ORG_ID = "org_ai_overview_e2e"
const FOREIGN_ORG_ID = "org_ai_overview_e2e_other"

// Anchored to now: `traces` and `ai_trace_index` both enforce a 30-day TTL at
// insert, so a hardcoded date would one day drop every seed and leave the suite
// comparing nothing to nothing.
const HOUR_MS = 3_600_000
const BASE_MS = Math.floor((Date.now() - 2 * HOUR_MS) / 1000) * 1000

/** Half an hour on — far enough to land in its own five-minute bucket. */
const LATER_MS = BASE_MS + 1_800_000

/** Inside the comparison window, which ends where the caller's begins. */
const EARLIER_MS = BASE_MS - 2 * HOUR_MS

const SESSION_ID = `${ORG_ID}:overview-1`
/** The ordinary shape: a turn span that rolls up its two model calls, and a
 *  tool call that failed. Its GPT call failed too. */
const TRACE_TURN = "aioverve2e00000000000000000000001"
/** The gateway's own trace of the first model call — same session, same
 *  response id, a price the app's SDK did not have, and the SAME failure: one
 *  call, netted, but two failed model-call spans. */
const TRACE_MIRROR = "aioverve2e00000000000000000000002"
/** No session id anywhere, so the trace IS the session. Its model call failed. */
const TRACE_SESSIONLESS = "aioverve2e00000000000000000000003"
/** A row written before the token buckets existed — inserted into the index
 *  directly, because the materialized view derives the buckets from the same
 *  attributes as the total and cannot produce one. */
const TRACE_PRE_BUCKETS = "aioverve2e00000000000000000000004"
/** The comparison window's only session. */
const TRACE_EARLIER = "aioverve2e00000000000000000000005"
const TRACE_FOREIGN = "aioverve2e00000000000000000000006"
/** More models than the mix plots bands for, half an hour PAST the window
 *  every other read here takes — so the fold has a population to fold and no
 *  other assertion has to account for it. */
const TRACE_MODEL_TAIL = "aioverve2e00000000000000000000007"

const GPT = "gpt-5"
const CLAUDE = "claude-sonnet-5"
/** One span each, so the ranking falls to the tie-break and the bands are
 *  `tail-model-1` … `tail-model-5` with the last two under `other`. */
const TAIL_MODELS = [1, 2, 3, 4, 5, 6, 7].map((n) => `tail-model-${n}`)
/** Half an hour past the window's end. */
const TAIL_MS = BASE_MS + HOUR_MS + 1_800_000
/** The response id the app's SDK and the gateway both report for one call. */
const SHARED_RESPONSE_ID = "resp-shared-1"

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

/** Tokens and a price, under the canonical semconv keys. */
const usage = (input: number, output: number, cost: number, responseId?: string) => {
	const base = {
		"gen_ai.usage.input_tokens": String(input),
		"gen_ai.usage.output_tokens": String(output),
		"gen_ai.usage.cost": String(cost),
	}
	return responseId === undefined ? base : { ...base, "gen_ai.response.id": responseId }
}

const SEED_SPANS: ReadonlyArray<SeedSpan> = [
	// The turn span carries the session id AND its children's usage summed onto
	// it — the roll-up the netting has to cancel.
	{
		traceId: TRACE_TURN,
		spanId: "overview-turn-1",
		name: "invoke_agent slack-agent",
		ms: BASE_MS,
		durationNs: 10_000_000,
		status: "Ok",
		attrs: agentSpan({
			[MAPLE_AI_SESSION_ID_ATTR]: SESSION_ID,
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": "slack-agent",
			...usage(120, 60, 0.03),
		}),
	},
	// The call the gateway mirrors below, and it FAILED — so the same failure is
	// on the wire twice while the netting collapses the two spans into one call.
	{
		traceId: TRACE_TURN,
		spanId: "overview-chat-gpt",
		parentSpanId: "overview-turn-1",
		name: "chat gpt-5",
		ms: BASE_MS + 1,
		durationNs: 4_000_000,
		status: "Error",
		attrs: agentSpan({
			"gen_ai.operation.name": "chat",
			"gen_ai.response.model": GPT,
			...usage(100, 50, 0.02, SHARED_RESPONSE_ID),
		}),
	},
	// A second model, in the same session — what makes the breakdown's rows
	// overlap.
	{
		traceId: TRACE_TURN,
		spanId: "overview-chat-claude",
		parentSpanId: "overview-turn-1",
		name: "chat claude-sonnet-5",
		ms: BASE_MS + 4,
		durationNs: 3_000_000,
		status: "Ok",
		attrs: agentSpan({
			"gen_ai.operation.name": "chat",
			"gen_ai.response.model": CLAUDE,
			...usage(20, 10, 0.01, "resp-claude-1"),
		}),
	},
	{
		traceId: TRACE_TURN,
		spanId: "overview-tool-1",
		parentSpanId: "overview-chat-gpt",
		name: "execute_tool search_traces",
		ms: BASE_MS + 2,
		durationNs: 1_000_000,
		status: "Error",
		attrs: agentSpan({
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "search_traces",
		}),
	},
	// The gateway's mirror: its own trace of the GPT call, under the same
	// session id and the same response id, priced higher — and carrying the
	// call's failure a second time.
	{
		traceId: TRACE_MIRROR,
		spanId: "overview-chat-mirror",
		name: "chat gpt-5",
		ms: BASE_MS + 3,
		durationNs: 5_000_000,
		status: "Error",
		attrs: agentSpan({
			[MAPLE_AI_SESSION_ID_ATTR]: SESSION_ID,
			"gen_ai.operation.name": "chat",
			"gen_ai.response.model": GPT,
			...usage(100, 50, 0.05, SHARED_RESPONSE_ID),
		}),
	},
	// A sessionless trace, half an hour later, whose model call failed.
	{
		traceId: TRACE_SESSIONLESS,
		spanId: "overview-chat-late",
		name: "chat claude-sonnet-5",
		ms: LATER_MS,
		durationNs: 6_000_000,
		status: "Error",
		attrs: agentSpan({
			"gen_ai.operation.name": "chat",
			"gen_ai.response.model": CLAUDE,
			...usage(200, 100, 0.1, "resp-late-1"),
		}),
	},
	// The comparison window's only session.
	{
		traceId: TRACE_EARLIER,
		spanId: "overview-chat-earlier",
		name: "chat gpt-5",
		ms: EARLIER_MS,
		durationNs: 2_000_000,
		status: "Ok",
		attrs: agentSpan({
			"gen_ai.operation.name": "chat",
			"gen_ai.response.model": GPT,
			...usage(10, 5, 0.01, "resp-earlier-1"),
		}),
	},
	// Seven models in one bucket, outside every other read's window: the mix
	// plots five bands and counts the rest under `other`.
	...TAIL_MODELS.map((model, index) => ({
		traceId: TRACE_MODEL_TAIL,
		spanId: `overview-chat-tail-${index}`,
		name: `chat ${model}`,
		ms: TAIL_MS + index,
		durationNs: 1_000_000,
		status: "Ok",
		attrs: agentSpan({
			"gen_ai.operation.name": "chat",
			"gen_ai.response.model": model,
			...usage(1, 1, 0.001, `resp-tail-${index}`),
		}),
	})),
]

/** Another org's session, in the same window — the reads must never see it. */
const FOREIGN_SPAN: SeedSpan = {
	traceId: TRACE_FOREIGN,
	spanId: "overview-chat-foreign",
	name: "chat gpt-5",
	ms: BASE_MS + 5,
	durationNs: 9_000_000,
	status: "Ok",
	attrs: agentSpan({
		"gen_ai.operation.name": "chat",
		"gen_ai.response.model": GPT,
		...usage(999, 999, 9.99, "resp-foreign-1"),
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

	// The pre-0031 row, written straight into the index: a total with five
	// empty buckets, which is what every row materialized before the bucket
	// columns existed still looks like. The overview must report the total and
	// leave the buckets summing to nothing rather than inventing a split.
	await clickhouseExec(
		`INSERT INTO ai_trace_index
		 (OrgId, Timestamp, TraceId, SessionId, VendorId, ServiceName, DeploymentEnv, Model, AgentName, ToolName,
		  SpanId, ParentSpanId, Duration, IsError, IsLlmCall, IsToolCall, Tokens, Cost, ResponseId, VendorVersion,
		  InputTokens, CacheReadTokens, CacheWriteTokens, OutputTokens, ReasoningTokens)
		 VALUES (${quote(ORG_ID)}, ${quote(chDateTime(BASE_MS + 6))}, ${quote(TRACE_PRE_BUCKETS)}, '', 'eve',
		  'agent-service', 'production', '', '', '', 'overview-chat-legacy', '', 2000000, 0, 1, 0, 500, 0, '', '',
		  0, 0, 0, 0, 0)`,
		database,
	)
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
		...ANALYZER_STRICTNESS,
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

const window = {
	orgId: ORG_ID,
	startTime: chDateTime(BASE_MS - HOUR_MS),
	endTime: chDateTime(BASE_MS + HOUR_MS),
}

/** The comparison window the route computes: equal length, ending where the
 *  caller's begins. `TRACE_EARLIER` is the only session inside it. */
const compareWindow = {
	...window,
	prevStartTime: chDateTime(BASE_MS - 3 * HOUR_MS),
	prevEndTime: chDateTime(BASE_MS - HOUR_MS),
}

const totals = async (opts: Integrations.AiOverviewFilterOpts = {}) => {
	const compiled = compileUnionUnsafe(Integrations.aiOverviewTotalsQuery(opts), compareWindow)
	const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))
	return {
		current: rows.find((row) => row.period === "current"),
		previous: rows.find((row) => row.period === "previous"),
	}
}

/** The sessions list over the same window — what every number here is checked
 *  against. */
const listRows = async (opts: Integrations.AiSessionPageOpts = {}) => {
	const compiled = compileUnsafe(Integrations.aiSessionPageQuery(opts), window)
	return Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))
}

const sumOf = <T>(rows: ReadonlyArray<T>, read: (row: T) => number) =>
	rows.reduce((total, row) => total + read(row), 0)

describe.skipIf(!clickhouseE2eEnabled)("agent overview reads", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("counts the sessions the list would have listed, and nobody else's", async () => {
		const { current } = await totals()
		const list = await listRows()

		// Three sessions: the vendor's own (two traces, the turn's and the
		// gateway's mirror of it), the sessionless trace, and the pre-0031 row.
		// The foreign org's session is in neither.
		assert.strictEqual(current?.sessions, list.length)
		assert.strictEqual(current?.sessions, 3)
		assert.deepStrictEqual(
			[...list].map((row) => row.sessionId).sort(),
			[SESSION_ID, `trace:${TRACE_PRE_BUCKETS}`, `trace:${TRACE_SESSIONLESS}`].sort(),
		)
	})

	it("nets usage exactly as the list nets it — the roll-up, the mirror and the retry", async () => {
		const { current } = await totals()
		const list = await listRows()

		// The turn span reports its children's tokens as its own and the gateway
		// reports the GPT call a second time: 180 raw tokens on the turn, 180 on
		// its two model calls and 150 on the mirror, which is 510 summed and 180
		// netted — 150 for the GPT call (once, priced at the higher of the two
		// claims) and 30 for the Claude call.
		assert.strictEqual(current?.tokens, sumOf(list, (row) => row.totalTokens))
		assert.strictEqual(current?.tokens, 180 + 300 + 500)
		assert.closeTo(
			current!.cost,
			sumOf(list, (row) => row.cost),
			1e-9,
		)
		// 0.05 for the mirrored call (the gateway's price, not the SDK's), 0.01
		// for the Claude call, 0.10 for the late one; the roll-up adds nothing.
		assert.closeTo(current!.cost, 0.16, 1e-9)
		assert.strictEqual(current?.llmCalls, sumOf(list, (row) => row.llmCalls))
		assert.strictEqual(current?.llmCalls, 4)
		// Coverage, not a price: every call but the pre-0031 one carried one.
		assert.strictEqual(current?.pricedLlmCalls, 3)
		assert.strictEqual(current?.toolCalls, sumOf(list, (row) => row.toolCalls))
		assert.strictEqual(current?.toolCalls, 1)
	})

	it("leaves a pre-bucket row's total whole and its buckets empty", async () => {
		const { current } = await totals()

		// The five buckets are the disjoint split of the total for every row
		// materialized since migration 0031, and zeros for the rows before it.
		// Summing them to the total in SQL would invent a split the row never
		// reported; the client falls back to the total instead.
		assert.strictEqual(current?.inputTokens, 120 + 200)
		assert.strictEqual(current?.outputTokens, 60 + 100)
		assert.strictEqual(current?.cacheReadTokens, 0)
		assert.strictEqual(current?.cacheWriteTokens, 0)
		assert.strictEqual(current?.reasoningTokens, 0)
		const buckets =
			current!.inputTokens +
			current!.cacheReadTokens +
			current!.cacheWriteTokens +
			current!.outputTokens +
			current!.reasoningTokens
		assert.strictEqual(buckets, 480)
		assert.isBelow(buckets, current!.tokens)
	})

	it("counts failures against the population each belongs to", async () => {
		const { current } = await totals()
		const list = await listRows()

		// Two of the three sessions carry a failed agent span — the same two the
		// list's own `hasErrors` matches.
		assert.strictEqual(current?.erroredSessions, list.filter((row) => row.errorAgentSpans > 0).length)
		assert.strictEqual(current?.erroredSessions, 2)
		// One failed tool call, out of one. The list counts the DEEPEST failure
		// (a failed tool whose child also failed is the child's echo) while this
		// counts the failed tool spans; the two agree here because no failed span
		// sits under the failed tool.
		assert.strictEqual(current?.erroredToolCalls, 1)
		assert.strictEqual(current?.erroredToolCalls, sumOf(list, (row) => row.toolErrors))

		// The GPT call failed and the gateway mirrored that failure into its own
		// trace, so three of the five model-call SPANS failed — while those five
		// spans net to four calls. The rate is the failures over the population
		// they were counted in, which cannot pass 100%; over `llmCalls` the
		// mirrored call would be counted twice against itself.
		assert.strictEqual(current?.erroredLlmCalls, 3)
		assert.strictEqual(current?.llmCallSpans, 5)
		assert.strictEqual(current?.llmCalls, 4)
		assert.closeTo(current!.erroredLlmCalls / current!.llmCallSpans, 3 / 5, 1e-9)
		assert.isAtMost(current!.erroredLlmCalls / current!.llmCallSpans, 1)

		// And the filter selects exactly those sessions.
		const failing = await totals({ hasErrors: true })
		assert.strictEqual(failing.current?.sessions, 2)
		assert.strictEqual(failing.current?.erroredSessions, 2)
	})

	it("measures the session's extent, first agent span to last", async () => {
		const { current } = await totals()
		const list = await listRows()

		// The session's extent is its first span to its last span's END: 10ms for
		// the turn's session (its own span outlives every call beneath it), 6ms
		// and 2ms for the other two — the same three the list reports.
		const extents = [...list].map((row) => row.agentDurationMs).sort((a, b) => a - b)
		assert.deepStrictEqual(extents, [2, 6, 10])
		assert.strictEqual(current?.sessionDurationP50Ns, extents[1]! * 1_000_000)
		assert.isAbove(current!.sessionDurationP95Ns, extents[1]! * 1_000_000)
		assert.isAtMost(current!.sessionDurationP95Ns, extents[2]! * 1_000_000)
	})

	it("measures the window before the caller's in the same read", async () => {
		const { previous } = await totals()

		// One session, an hour before the window opens. Nothing of the current
		// window leaks into it.
		assert.strictEqual(previous?.sessions, 1)
		assert.strictEqual(previous?.tokens, 15)
		assert.closeTo(previous!.cost, 0.01, 1e-9)
		assert.strictEqual(previous?.toolCalls, 0)
	})

	it("files a session under the bucket it started in, so the buckets sum to the totals", async () => {
		const compiled = compileUnionUnsafe(Integrations.aiOverviewSeriesQuery(), {
			...compareWindow,
			bucketSeconds: 300,
		})
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))
		const series = rows.filter((row) => row.period === "current")
		const { current } = await totals()

		// Two buckets: the turn's session and the pre-0031 row in the first, the
		// sessionless trace half an hour later in its own.
		assert.strictEqual(series.length, 2)
		assert.isTrue(series[0]!.bucket < series[1]!.bucket, `${series[0]!.bucket} < ${series[1]!.bucket}`)
		assert.strictEqual(
			sumOf(series, (row) => row.sessions),
			current?.sessions,
		)
		assert.strictEqual(
			sumOf(series, (row) => row.tokens),
			current?.tokens,
		)
		assert.closeTo(
			sumOf(series, (row) => row.cost),
			current!.cost,
			1e-9,
		)
		assert.strictEqual(
			sumOf(series, (row) => row.llmCalls),
			current?.llmCalls,
		)
		// The session the gateway mirrored spans both its traces and still lands
		// in one bucket — the one its first span started in.
		assert.strictEqual(series[0]?.sessions, 2)
		assert.strictEqual(rows.filter((row) => row.period === "previous").length, 1)
	})

	it("files a session under every model it used, and its tokens under the call that reported them", async () => {
		const compiled = compileUnionUnsafe(
			Integrations.aiOverviewBreakdownQuery({ dimension: "model" }),
			compareWindow,
		)
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))
		const byKey = new Map(rows.filter((row) => row.period === "current").map((row) => [row.key, row]))
		const { current } = await totals()

		// The turn's session used two models, so it is a session under each —
		// rows overlap and do not sum to the totals.
		assert.deepStrictEqual([...byKey.keys()].sort(), ["", CLAUDE, GPT])
		assert.strictEqual(byKey.get(GPT)?.sessions, 1)
		assert.strictEqual(byKey.get(CLAUDE)?.sessions, 2)
		assert.isAbove(
			sumOf([...byKey.values()], (row) => row.sessions),
			current!.sessions,
		)

		// The usage does NOT overlap: a call's tokens are charged to the model
		// that reported them, with the mirror still collapsed onto one claim and
		// the turn span's roll-up — which names no model — never counted.
		assert.strictEqual(byKey.get(GPT)?.tokens, 150)
		assert.closeTo(byKey.get(GPT)!.cost, 0.05, 1e-9)
		assert.strictEqual(byKey.get(CLAUDE)?.tokens, 30 + 300)
		assert.closeTo(byKey.get(CLAUDE)!.cost, 0.11, 1e-9)
		// And the mirror is where the two model-call populations part: under GPT,
		// two failed spans over two spans, which net to one call. A rate taken
		// against the netted call would read 200%.
		assert.strictEqual(byKey.get(GPT)?.erroredLlmCalls, 2)
		assert.strictEqual(byKey.get(GPT)?.llmCallSpans, 2)
		assert.strictEqual(byKey.get(GPT)?.llmCalls, 1)

		// The pre-0031 row names no model and is the unattributed key, not a gap.
		assert.strictEqual(byKey.get("")?.tokens, 500)
		assert.strictEqual(
			sumOf([...byKey.values()], (row) => row.tokens),
			current?.tokens,
		)

		// The previous window is measured over the same keys, and the third
		// branch counts what the table is not showing.
		const previous = rows.filter((row) => row.period === "previous")
		assert.deepStrictEqual(
			previous.map((row) => row.key),
			[GPT],
		)
		assert.strictEqual(previous[0]?.tokens, 15)
		assert.strictEqual(rows.find((row) => row.period === "keys")?.keyCount, 3)
	})

	it("reads a tool breakdown over tool calls and an agent breakdown over every span", async () => {
		const read = async (dimension: Integrations.AiOverviewBreakdownOpts["dimension"]) => {
			const compiled = compileUnionUnsafe(
				Integrations.aiOverviewBreakdownQuery({ dimension }),
				compareWindow,
			)
			const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))
			return rows.filter((row) => row.period === "current")
		}

		// One tool, called once, and it failed. A tool span reports no usage, so
		// its row costs nothing — which is the honest answer, not a missing one.
		const tools = await read("tool")
		assert.deepStrictEqual(
			tools.map((row) => ({ key: row.key, toolCalls: row.toolCalls, errored: row.erroredToolCalls })),
			[{ key: "search_traces", toolCalls: 1, errored: 1 }],
		)
		assert.strictEqual(tools[0]?.cost, 0)

		// Agent names sit on the turn span alone, so the rest of the spans key
		// under '' — the unattributed row the page shows beside the named one.
		const agents = await read("agent")
		assert.deepStrictEqual([...agents].map((row) => row.key).sort(), ["", "slack-agent"])

		// Every agent span carries a service and a vendor, so those two never
		// have an unattributed row.
		const services = await read("service")
		assert.deepStrictEqual(
			services.map((row) => ({ key: row.key, sessions: row.sessions })),
			[{ key: "agent-service", sessions: 3 }],
		)
	})

	it("splits the window's model-call spans by model, without netting a single one", async () => {
		const modelMix = async (opts: Integrations.AiOverviewFilterOpts = {}) => {
			const compiled = compileUnsafe(Integrations.aiOverviewModelMixQuery(opts), {
				...window,
				bucketSeconds: 300,
			})
			return Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))
		}

		const rows = await modelMix()
		const { current } = await totals()

		// Two buckets, half an hour apart, and the busiest model of a bucket
		// first. The gateway's mirror is a SPAN of its own here — the netting
		// that makes it one call never runs — so GPT carries two.
		assert.deepStrictEqual(
			rows.map((row) => ({ model: row.model, spans: row.llmCallSpans })),
			[
				{ model: GPT, spans: 2 },
				{ model: CLAUDE, spans: 1 },
				{ model: CLAUDE, spans: 1 },
			],
		)
		assert.strictEqual(rows[0]!.bucket, rows[1]!.bucket)
		assert.isTrue(rows[1]!.bucket < rows[2]!.bucket, `${rows[1]!.bucket} < ${rows[2]!.bucket}`)

		// The tool call is not a model call, and the pre-0031 row is a model call
		// that named no model — so the mix is exactly the summary's SPAN
		// population less that one row. GPT's two spans against the one call they
		// net to is the whole difference between this read and the breakdown.
		assert.strictEqual(
			sumOf(rows, (row) => row.llmCallSpans),
			current!.llmCallSpans - 1,
		)
		assert.strictEqual(
			sumOf(rows, (row) => row.llmCallSpans),
			4,
		)
		assert.isFalse(rows.some((row) => row.model === "" || row.model === "search_traces"))

		// A model filter is the per-trace existence test every other overview
		// read applies: it drops the sessionless trace, which never called GPT,
		// and keeps every model span of the traces it selected — so Claude is
		// still a band under a GPT filter.
		const gptOnly = await modelMix({ models: [GPT] })
		assert.deepStrictEqual(
			gptOnly.map((row) => ({ model: row.model, spans: row.llmCallSpans })),
			[
				{ model: GPT, spans: 2 },
				{ model: CLAUDE, spans: 1 },
			],
		)
		assert.strictEqual(gptOnly[0]!.bucket, rows[0]!.bucket)
	})

	it("counts every model past the busiest five under one band", async () => {
		// The tail trace's own window: seven models, one span each, in a single
		// bucket. Folded client-side this is seven rows a bucket and the row cap
		// would one day cut the newest bucket off the chart.
		const compiled = compileUnsafe(Integrations.aiOverviewModelMixQuery(), {
			orgId: ORG_ID,
			startTime: chDateTime(TAIL_MS - 60_000),
			endTime: chDateTime(TAIL_MS + 60_000),
			bucketSeconds: 300,
		})
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))

		// Six rows and not seven: the five bands the ranking kept — ties broken by
		// name, so the bands are stable between loads — and `other` for the rest.
		assert.strictEqual(rows.length, 6)
		assert.deepStrictEqual(
			[...rows].map((row) => row.model).sort(),
			[...TAIL_MODELS.slice(0, 5), "other"].sort(),
		)
		assert.strictEqual(rows.find((row) => row.model === "other")?.llmCallSpans, 2)
		assert.strictEqual(
			sumOf(rows, (row) => row.llmCallSpans),
			TAIL_MODELS.length,
		)
	})

	it("selects sessions the way the list selects them, by any span of the trace", async () => {
		// A model filter and a tool filter together: they are matched by
		// DIFFERENT spans of the same trace, which a row predicate could never
		// do — and the session the two select is the one the list selects.
		const { current } = await totals({ models: [GPT], toolNames: ["search_traces"] })
		const list = await listRows({ models: [GPT], toolNames: ["search_traces"] })

		assert.strictEqual(current?.sessions, list.length)
		assert.strictEqual(current?.sessions, 1)
		assert.strictEqual(current?.tokens, sumOf(list, (row) => row.totalTokens))

		// A filter no span carries selects nothing, rather than everything.
		const none = await totals({ vendorIds: ["vercel_ai_sdk"] })
		assert.strictEqual(none.current?.sessions, 0)
		assert.strictEqual(none.current?.cost, 0)
		assert.strictEqual(none.current?.sessionDurationP50Ns, 0)
	})
})
