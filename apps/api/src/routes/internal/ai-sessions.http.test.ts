// SAFETY-FILE: JSON in this test is emitted by the route under test before its fields are asserted.
import { describe, expect, it } from "@effect/vitest"
import {
	AiSessionsInternalApiGroup,
	AI_SESSION_SPANS_MAX_SPANS,
	AI_SESSION_SUMMARY_MAX_TURNS,
	CurrentTenant,
	V1SchemaErrors,
	V1UnexpectedErrors,
} from "@maple/domain/http"

import { WarehouseResponseLimitError } from "@maple/query-engine/execution"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import type { WarehouseQueryServiceApi } from "@/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "../v2/v2-test-support"
import { V1ErrorBoundaryLive } from "../v1/error-boundary"
import { HttpAiSessionsInternalLive } from "./ai-sessions.http"
import { compiledQueryOf } from "@maple/query-engine/execution"

/**
 * The truncation contract of `POST /internal/ai-sessions/spans`: what the row
 * cap does, and what the byte cap does instead. Both are one-off shapes the
 * other warehouse reads have no equivalent of.
 *
 * Plus that `mapAiSpans` actually puts values on the wire, and that the facets
 * split agrees with the literals the query emits — both sides of which are
 * bare strings.
 */

class AiSessionsOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(AiSessionsInternalApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors) {}

const SESSION_ID = "wrun_01KZTEST"
const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
const WINDOW = {
	startTime: "2026-08-19 09:00:00",
	endTime: "2026-08-19 11:00:00",
}
const SPANS_BODY = { sessionId: SESSION_ID, ...WINDOW }

const TENANT = new CurrentTenant.TenantSchema({
	orgId: "org_ai_sessions" as CurrentTenant.TenantSchema["orgId"],
	userId: "user_ai_sessions" as CurrentTenant.TenantSchema["userId"],
	roles: [],
	authMode: "self_hosted",
})

const AuthorizationStubLayer = Layer.succeed(
	CurrentTenant.SessionAuthorization,
	CurrentTenant.SessionAuthorization.of({
		bearer: (httpEffect) => Effect.provideService(httpEffect, CurrentTenant.Context, TENANT),
	}),
)

/** One warehouse row, in the wire shape `aiSessionSpansRowSchema` decodes. */
const spanRow = (index: number) => ({
	traceId: TRACE_ID,
	spanId: index.toString(16).padStart(16, "0"),
	parentSpanId: "",
	spanName: "chat",
	spanKind: "SPAN_KIND_CLIENT",
	serviceName: "agent-runner",
	durationMs: 12,
	statusCode: "Unset",
	statusMessage: "",
	timestamp: "2026-08-19 10:00:00.000000000",
	spanAttributes: { "gen_ai.operation.name": "chat", "maple_ai.session.id": SESSION_ID },
})

const makeHarness = (overrides: Partial<WarehouseQueryServiceApi>) => {
	const routes = HttpApiBuilder.layer(AiSessionsOnlyApi).pipe(
		Layer.provide(HttpAiSessionsInternalLive),
		Layer.provide(V1ErrorBoundaryLive),
		Layer.provideMerge(AuthorizationStubLayer),
		Layer.provideMerge(Layer.succeed(WarehouseQueryService, makeWarehouseServiceStub(overrides))),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes as never, {
		disableLogger: true,
	})

	const post = async (path: string, body: unknown) => {
		// SAFETY: the handler's second argument is the Worker environment context,
		// and these routes read nothing out of it.
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return {
			status: response.status,
			body: JSON.parse(text) as Record<string, unknown>,
		}
	}

	return { post, dispose }
}

describe("POST /internal/ai-sessions/spans", () => {
	it("answers a response-limit failure with the 413 the client can act on", async () => {
		const harness = makeHarness({
			compiledQueryBounded: () =>
				Effect.fail(
					new WarehouseResponseLimitError({
						kind: "bytes",
						message: "response too large",
					}),
				),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", SPANS_BODY)
			expect(response.status).toBe(413)
			expect(response.body._tag).toBe("@maple/http/ai-sessions/AiSessionTooLargeError")
			expect(response.body.sessionId).toBe(SESSION_ID)
		} finally {
			await harness.dispose()
		}
	})

	it("cuts the page at the row cap and hands back where the next one starts", async () => {
		// The query asks for one row past the cap precisely so this case is
		// distinguishable from a session that exactly fills it.
		const rows = Array.from({ length: AI_SESSION_SPANS_MAX_SPANS + 1 }, (_, index) => spanRow(index))
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) =>
				compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", SPANS_BODY)
			expect(response.status).toBe(200)
			expect(response.body.data).toHaveLength(AI_SESSION_SPANS_MAX_SPANS)
			// The last row RETURNED, not the extra one: the next page starts after it.
			const last = spanRow(AI_SESSION_SPANS_MAX_SPANS - 1)
			expect(response.body.nextCursor).toEqual({ timestamp: last.timestamp, spanId: last.spanId })
		} finally {
			await harness.dispose()
		}
	})

	it("reports a session that fits as complete", async () => {
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([spanRow(0), spanRow(1)])
					.pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", SPANS_BODY)
			expect(response.status).toBe(200)
			expect(response.body.nextCursor).toBeUndefined()
			expect(response.body.data).toHaveLength(2)
		} finally {
			await harness.dispose()
		}
	})

	// A link that arrives with no `t`/`end` — pasted, or written by an agent. The
	// endpoint must resolve the session's real bounds rather than invent a range
	// OR read unbounded, and the compiled SQL is where that is decidable: the
	// resolve step is the only one allowed to carry no `Timestamp` predicate.
	it("resolves bounds from the id, then reads the spans within them", async () => {
		const resolved = {
			startTime: "2026-08-18 09:00:00.000000000",
			endTime: "2026-08-20 11:00:00.000000000",
		}
		let windowSql: string | undefined
		let spansSql: string | undefined
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				windowSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([{ ...resolved, spanCount: "9" }])
					.pipe(Effect.orDie)
			},
			compiledQueryBounded: (_tenant, compiled) => {
				spansSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0), spanRow(1)])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", {
				sessionId: SESSION_ID,
			})
			expect(response.status).toBe(200)
			expect(response.body.data).toHaveLength(2)
			// The bloom-indexed detection scan, unbounded on purpose.
			expect(windowSql).toContain(`SpanAttributes['maple_ai.session.id'] = '${SESSION_ID}'`)
			expect(windowSql).not.toContain("Timestamp >=")
			// The fan-out, which never runs that way.
			expect(spansSql).toContain(`Timestamp >= '${resolved.startTime}'`)
			expect(spansSql).toContain(`Timestamp <= '${resolved.endTime}'`)
			// An unbound placeholder would reach ClickHouse verbatim.
			expect(spansSql).not.toContain("__PARAM_")
		} finally {
			await harness.dispose()
		}
	})

	// A `trace:` id is Maple's own: the vendor exposed no session key, so the
	// trace IS the session. Both reads must key on the trace id — the session
	// attribute would match nothing, and the page would report an empty session
	// for a trace that is right there.
	it("routes a trace-scoped id to the trace-keyed window and span reads", async () => {
		const resolved = {
			startTime: "2026-08-18 09:00:00.000000000",
			endTime: "2026-08-20 11:00:00.000000000",
		}
		let windowSql: string | undefined
		let spansSql: string | undefined
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				windowSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([{ ...resolved, spanCount: "9" }])
					.pipe(Effect.orDie)
			},
			compiledQueryBounded: (_tenant, compiled) => {
				spansSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0), spanRow(1)])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", {
				sessionId: `trace:${TRACE_ID}`,
			})
			expect(response.status).toBe(200)
			expect(response.body.data).toHaveLength(2)
			expect(windowSql).toContain(`TraceId = '${TRACE_ID}'`)
			expect(windowSql).not.toContain("maple_ai.session.id")
			expect(spansSql).toContain(`TraceId = '${TRACE_ID}'`)
			// The projection names the key; the predicate is what must be absent.
			expect(spansSql).not.toContain("SpanAttributes['maple_ai.session.id']")
			// The bounds the window read handed back still prune the span read.
			expect(spansSql).toContain(`Timestamp >= '${resolved.startTime}'`)
			expect(spansSql).not.toContain("__PARAM_")
		} finally {
			await harness.dispose()
		}
	})

	// The prefix is not proof: the value behind it reaches a warehouse param, so
	// anything that is not a trace id must not get there. It falls through to the
	// session read, where nothing carries it — the empty answer any unknown id gets.
	it("does not hand a malformed trace-scoped id to the trace-keyed read", async () => {
		let windowSql: string | undefined
		let spansRead = false
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				windowSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([
						{
							startTime: "1970-01-01 00:00:00.000000000",
							endTime: "1970-01-02 00:00:00.000000000",
							spanCount: "0",
						},
					])
					.pipe(Effect.orDie)
			},
			compiledQueryBounded: (_tenant, compiled) => {
				spansRead = true
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0)])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", {
				sessionId: "trace:not-a-trace-id' OR 1=1",
			})
			expect(response.status).toBe(200)
			expect(response.body).toEqual({ data: [] })
			expect(windowSql).toContain("SpanAttributes['maple_ai.session.id'] =")
			expect(windowSql).not.toContain("TraceId =")
			expect(spansRead).toBe(false)
		} finally {
			await harness.dispose()
		}
	})

	it("answers an id nothing in retention carries without reading spans", async () => {
		let spansRead = false
		const harness = makeHarness({
			// `min`/`max` over no rows come back as the epoch, so the count is the
			// only thing that says the session does not exist.
			compiledQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([
						{
							startTime: "1970-01-01 00:00:00.000000000",
							endTime: "1970-01-02 00:00:00.000000000",
							spanCount: "0",
						},
					])
					.pipe(Effect.orDie),
			compiledQueryBounded: (_tenant, compiled) => {
				spansRead = true
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0)])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", {
				sessionId: SESSION_ID,
			})
			expect(response.status).toBe(200)
			expect(response.body).toEqual({ data: [] })
			expect(spansRead).toBe(false)
		} finally {
			await harness.dispose()
		}
	})

	it("bounds the read by the window when the caller supplies one", async () => {
		let compiledSql: string | undefined
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) => {
				compiledSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0)])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", SPANS_BODY)
			expect(response.status).toBe(200)
			expect(compiledSql).toContain(`Timestamp >= '${WINDOW.startTime}'`)
			expect(compiledSql).toContain(`Timestamp <= '${WINDOW.endTime}'`)
		} finally {
			await harness.dispose()
		}
	})

	it("puts the mapped attribute values on the wire, not just the keys", async () => {
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([spanRow(0)])
					.pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", SPANS_BODY)
			const [span] = response.body.data as ReadonlyArray<Record<string, unknown>>
			expect(span).toMatchObject({
				sessionId: SESSION_ID,
				spanName: "chat",
				serviceName: "agent-runner",
				isAiSpan: true,
				genAi: { operationName: "chat" },
			})
		} finally {
			await harness.dispose()
		}
	})
})

/**
 * The list is two reads, and the handler is what holds them together: it derives
 * the fan-out's window from the page, and it re-imposes the page's order on an
 * aggregation that cannot know it. Both are invisible in either query alone.
 */
describe("POST /internal/ai-sessions/list", () => {
	const LIST_BODY = { ...WINDOW, limit: 3 }

	/** A page row in the wire shape the index read decodes: everything the
	 *  list row shows, measured over the session's agent spans. */
	const pageRow = (sessionId: string, agentStart: string, agentEnd: string) => ({
		sessionId,
		vendorId: "eve",
		vendorVersion: "1",
		agentStart,
		agentEnd,
		traceCount: "2",
		spanCount: "7",
		serviceNames: ["agent-runner"],
		models: ["claude-sonnet-5"],
		// Deliberately not `agentNames[0]`: the query resolves the heading name in
		// span order, the set is unordered, and the route must carry the former.
		agentNames: ["web-fetcher", "slack-agent"],
		firstAgentName: "slack-agent",
		llmCalls: "4",
		toolCalls: "2",
		errorAgentSpans: "1",
		toolErrors: 1,
		turnErrors: 0,
		totalTokens: 18_400,
		inputTokens: 12_000,
		cacheReadTokens: 4_000,
		cacheWriteTokens: 0,
		outputTokens: 2_000,
		reasoningTokens: 400,
		cost: 0.12,
		agentDurationMs: "600000",
	})

	const PAGE = [
		pageRow("wrun_beta", "2026-08-19 10:20:00.000000000", "2026-08-19 10:30:00.000000000"),
		pageRow("wrun_alpha", "2026-08-19 10:05:00.000000000", "2026-08-19 10:40:00.000000000"),
		pageRow(`trace:${TRACE_ID}`, "2026-08-19 09:50:00.000000000", "2026-08-19 10:00:00.000000000"),
	]

	it("answers from one index read over the caller's window, never touching trace_detail_spans", async () => {
		const contexts: Array<string | undefined> = []
		let pageSql: string | undefined
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled, options) => {
				contexts.push(options?.context)
				pageSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled).decodeRows(PAGE).pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/list", LIST_BODY)
			expect(response.status).toBe(200)
			// The fan-out over `trace_detail_spans` is seconds on a cold partition,
			// which is why it is the client's second request (`/details`) and not
			// part of this one.
			expect(contexts).toEqual(["aiSessionsPage"])
			expect(pageSql).toContain("FROM ai_trace_index")
			expect(pageSql).not.toContain("trace_detail_spans")
			expect(pageSql).toContain(`Timestamp <= '${WINDOW.endTime}'`)
			expect(pageSql).toContain("LIMIT 3")
			expect(pageSql).not.toContain("__PARAM_")
		} finally {
			await harness.dispose()
		}
	})

	it("carries the index's row through in the page's order, its agent-span extent as the bounds", async () => {
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => compiledQueryOf(compiled).decodeRows(PAGE).pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/list", LIST_BODY)
			expect(response.status).toBe(200)
			const data = response.body.data as ReadonlyArray<Record<string, unknown>>
			// The page's order is the order that was paged; re-sorting here would
			// let a row jump between pages on a scroll.
			expect(data.map((r) => r.sessionId)).toEqual(["wrun_beta", "wrun_alpha", `trace:${TRACE_ID}`])
			expect(data[0]).toMatchObject({
				vendorId: "eve",
				vendorVersion: "1",
				traceCount: 2,
				// Agent spans and their services until the details replace them.
				spanCount: 7,
				serviceNames: ["agent-runner"],
				// The failed agent spans, under the row's all-span name; the split
				// beside it is the page's.
				errorSpanCount: 1,
				toolErrorCount: 1,
				turnErrorCount: 0,
				models: ["claude-sonnet-5"],
				agentNames: ["web-fetcher", "slack-agent"],
				firstAgentName: "slack-agent",
				llmCalls: 4,
				toolCalls: 2,
				totalTokens: 18_400,
				inputTokens: 12_000,
				cacheReadTokens: 4_000,
				cacheWriteTokens: 0,
				outputTokens: 2_000,
				reasoningTokens: 400,
				cost: 0.12,
				startTime: "2026-08-19 10:20:00.000000000",
				endTime: "2026-08-19 10:30:00.000000000",
				durationMs: 600_000,
			})
			expect(data[0]).not.toHaveProperty("errorAgentSpans")
			expect(data[0]).not.toHaveProperty("agentStart")
			// Every ranked session is a row now, and `ranked` stays the paging
			// contract the client sums its next offset from.
			expect(response.body.ranked).toBe(3)
		} finally {
			await harness.dispose()
		}
	})

	it("answers an empty page with no rows and no ranked count", async () => {
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/list", LIST_BODY)
			expect(response.status).toBe(200)
			// `ranked` is omitted entirely, not sent as 0: the field is an
			// `optionalKey`, and the client's `?? data.length` fallback reads it as
			// 0 either way, which is what ends the scroll.
			expect(response.body).toEqual({ data: [] })
			expect("ranked" in response.body).toBe(false)
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/details", () => {
	/** The page's extent as the client hands it back: its rows' earliest start
	 *  and latest end, verbatim. */
	const DETAILS_BODY = {
		startTime: "2026-08-19 09:50:00.000000000",
		endTime: "2026-08-19 10:40:00.000000000",
		sessionIds: ["wrun_beta", "wrun_alpha", `trace:${TRACE_ID}`],
		vendorIds: ["eve"],
	}

	/** A details row, in the wire shape the fan-out's SELECT decodes. */
	const detailsRow = (sessionId: string) => ({
		sessionId,
		spanCount: "12",
		errorSpanCount: "2",
		serviceNames: ["agent-runner", "web-service"],
		startTime: "2026-08-19 10:19:59.950000000",
		endTime: "2026-08-19 10:45:00.000000000",
		durationMs: "1500050",
	})

	it("fans out over the page's own extent, padded, and its ids under the page's filters", async () => {
		let detailsSql: string | undefined
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled, options) => {
				expect(options?.context).toBe("aiSessionsDetails")
				detailsSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows(DETAILS_BODY.sessionIds.map(detailsRow))
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/details", DETAILS_BODY)
			expect(response.status).toBe(200)
			// The fan-out reads `trace_detail_spans` over the page's extent, padded —
			// the caller's window would be a week of partitions on the page the UI
			// offers — and both `ai_trace_index` reads take the same bounds exactly.
			expect(detailsSql).toContain("FROM trace_detail_spans")
			expect(detailsSql).toContain("Timestamp >= '2026-08-19 09:50:00.000000000' - INTERVAL 3600 SECOND")
			expect(detailsSql).toContain("Timestamp <= '2026-08-19 10:40:00.000000000' + INTERVAL 3600 SECOND")
			expect(detailsSql?.split("Timestamp >= '2026-08-19 09:50:00.000000000'").length).toBe(4)
			// Exactly the page's ids, and the page's counted filters, so a trace
			// resolves to the session it was ranked into.
			for (const sessionId of DETAILS_BODY.sessionIds) expect(detailsSql).toContain(`'${sessionId}'`)
			expect(detailsSql).toContain("countIf(VendorId IN ('eve')) > 0")
			expect(detailsSql).not.toContain("__PARAM_")
			// The rows as the fan-out returned them; the client merges by id.
			expect(response.body).toEqual({
				data: DETAILS_BODY.sessionIds.map((sessionId) => ({
					sessionId,
					spanCount: 12,
					errorSpanCount: 2,
					serviceNames: ["agent-runner", "web-service"],
					startTime: "2026-08-19 10:19:59.950000000",
					endTime: "2026-08-19 10:45:00.000000000",
					durationMs: 1_500_050,
				})),
			})
		} finally {
			await harness.dispose()
		}
	})

	it("rejects an empty page rather than compiling `IN ()`", async () => {
		const harness = makeHarness({
			compiledQuery: () => Effect.die("unreachable"),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/details", {
				...DETAILS_BODY,
				sessionIds: [],
			})
			expect(response.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/facets", () => {
	// `pick("vendor")` in the handler and `facet("vendor", …)` in the query are
	// two independent string literals in two packages. If either drifts both
	// arrays come back empty behind a 200 and the sidebar silently loses every
	// option — a failure that looks exactly like "no data in this window".
	it("splits one union result into the six dimensions the sidebar reads", async () => {
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([
						{ facetType: "vendor", name: "eve", count: 7 },
						{ facetType: "service", name: "agent-runner", count: 4 },
						{ facetType: "vendor", name: "vercel_ai_sdk", count: 2 },
						{ facetType: "environment", name: "production", count: 9 },
						{ facetType: "model", name: "claude-sonnet-5", count: 6 },
						{ facetType: "agent", name: "slack-agent", count: 5 },
						{ facetType: "tool", name: "search_traces", count: 3 },
					])
					.pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/facets", WINDOW)
			expect(response.status).toBe(200)
			expect(response.body.vendors).toEqual([
				{ name: "eve", count: 7 },
				{ name: "vercel_ai_sdk", count: 2 },
			])
			expect(response.body.services).toEqual([{ name: "agent-runner", count: 4 }])
			expect(response.body.environments).toEqual([{ name: "production", count: 9 }])
			expect(response.body.models).toEqual([{ name: "claude-sonnet-5", count: 6 }])
			expect(response.body.agents).toEqual([{ name: "slack-agent", count: 5 }])
			expect(response.body.tools).toEqual([{ name: "search_traces", count: 3 }])
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/list", () => {
	// Every filter is a payload field the handler has to hand to the builder by
	// name; a field the schema accepts and the handler forgets is a 200 that
	// silently ignores the sidebar. So the compiled SQL is what gets asserted —
	// the page's, which the stub answers empty so the fan-out never runs.
	it("hands every filter and the sort to the page query", async () => {
		let sql = ""
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				sql = compiledQueryOf(compiled).sql
				return Effect.succeed([])
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/list", {
				...WINDOW,
				vendorIds: ["eve"],
				serviceNames: ["agent-runner"],
				deploymentEnvs: ["production"],
				models: ["claude-sonnet-5"],
				agentNames: ["slack-agent"],
				toolNames: ["search_traces"],
				search: "wrun01",
				hasErrors: true,
				excludeTraceSessions: true,
				durationMinMs: 1000,
				durationMaxMs: 90000,
				costMin: 0.25,
				costMax: 4,
				tokensMin: 10,
				tokensMax: 5000,
				llmCallsMin: 1,
				llmCallsMax: 20,
				toolCallsMin: 2,
				toolCallsMax: 30,
				sortBy: "cost",
				sortDir: "asc",
			})
			expect(response.status).toBe(200)
			expect(response.body).toEqual({ data: [] })
			for (const fragment of [
				"countIf(VendorId IN ('eve')) > 0",
				"countIf(ServiceName IN ('agent-runner')) > 0",
				"countIf(DeploymentEnv IN ('production')) > 0",
				"countIf(Model IN ('claude-sonnet-5')) > 0",
				"countIf(AgentName IN ('slack-agent')) > 0",
				"countIf(ToolName IN ('search_traces')) > 0",
				"SessionId LIKE 'wrun01%'",
				"errorAgentSpans > 0",
				"NOT (sessionId LIKE 'trace:%')",
				"agentDurationMs >= 1000",
				"agentDurationMs <= 90000",
				"cost >= 0.25",
				"cost <= 4",
				"totalTokens >= 10",
				"totalTokens <= 5000",
				"llmCalls >= 1",
				"llmCalls <= 20",
				"toolCalls >= 2",
				"toolCalls <= 30",
				"ORDER BY cost ASC, agentStart DESC, sessionId ASC",
			]) {
				expect(sql).toContain(fragment)
			}
		} finally {
			await harness.dispose()
		}
	})

	it("rejects a negative bound and an unknown sort key at the boundary", async () => {
		const harness = makeHarness({
			compiledQuery: () => Effect.succeed([]),
		})

		try {
			expect(
				(
					await harness.post("/internal/ai-sessions/list", {
						...WINDOW,
						costMin: -1,
					})
				).status,
			).toBe(400)
			expect(
				(
					await harness.post("/internal/ai-sessions/list", {
						...WINDOW,
						sortBy: "spanCount",
					})
				).status,
			).toBe(400)
			expect(
				(
					await harness.post("/internal/ai-sessions/list", {
						...WINDOW,
						tokensMin: 1.5,
					})
				).status,
			).toBe(400)
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/spans — pages and scopes", () => {
	const captureSpansSql = () => {
		let sql: string | undefined
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) => {
				sql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0)])
					.pipe(Effect.orDie)
			},
		})
		return { harness, sql: () => sql }
	}

	it("resumes after the cursor, on the agent spans alone", async () => {
		const { harness, sql } = captureSpansSql()
		try {
			const after = { timestamp: "2026-08-19 10:00:00.000000000", spanId: "00000000000007cf" }
			const response = await harness.post("/internal/ai-sessions/spans", {
				...SPANS_BODY,
				scope: "ai",
				after,
				limit: 500,
			})
			expect(response.status).toBe(200)
			expect(sql()).toContain("SpanAttributes['maple_ai.vendor.id'] != ''")
			expect(sql()).toContain(
				`(Timestamp > '${after.timestamp}' OR (Timestamp = '${after.timestamp}' AND SpanId > '${after.spanId}'))`,
			)
			expect(sql()).toContain("LIMIT 501")
		} finally {
			await harness.dispose()
		}
	})

	it("reads a turn's app spans by its traces, skipping session detection", async () => {
		const { harness, sql } = captureSpansSql()
		try {
			const other = "0123456789abcdef0123456789abcdef"
			const response = await harness.post("/internal/ai-sessions/spans", {
				...SPANS_BODY,
				scope: "app",
				traceIds: [TRACE_ID, other],
			})
			expect(response.status).toBe(200)
			expect(sql()).toContain(`TraceId IN ('${TRACE_ID}', '${other}')`)
			expect(sql()).toContain("SpanAttributes['maple_ai.vendor.id'] = ''")
			expect(sql()).not.toContain("FROM traces")
		} finally {
			await harness.dispose()
		}
	})

	it("refuses a trace-pinned read with no window to bound it", async () => {
		const { harness } = captureSpansSql()
		try {
			const response = await harness.post("/internal/ai-sessions/spans", {
				sessionId: SESSION_ID,
				traceIds: [TRACE_ID],
			})
			expect(response.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})

	it("refuses a trace id that is not one", async () => {
		const { harness } = captureSpansSql()
		try {
			const response = await harness.post("/internal/ai-sessions/spans", {
				...SPANS_BODY,
				traceIds: ["not-a-trace-id' OR 1=1"],
			})
			expect(response.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/summary", () => {
	/** One turn row, in the wire shape `aiSessionSummaryRowSchema` decodes. */
	const turnRow = (overrides: Record<string, unknown>) => ({
		turnKey: "turn_0",
		conversationId: "turn_0",
		traceIds: [TRACE_ID],
		startTime: "2026-08-19 10:00:00.000000000",
		endTime: "2026-08-19 10:00:10.000000000",
		durationMs: "10000",
		spanCount: "40",
		aiSpanCount: "6",
		llmCalls: "3",
		toolCalls: "2",
		errorSpanCount: "0",
		inputTokens: "0",
		outputTokens: "0",
		cacheReadTokens: "0",
		llmInputTokens: "0",
		llmOutputTokens: "0",
		llmCacheReadTokens: "0",
		costReporters: "0",
		cost: "0",
		llmCost: "0",
		models: ["gpt-5"],
		agentNames: ["slack-agent"],
		...overrides,
	})

	/** The session's own row, in the wire shape `aiSessionTotalsRowSchema` decodes. */
	const totalsRow = (overrides: Record<string, unknown>) => {
		const { turnKey: _turnKey, conversationId: _conversationId, traceIds: _traceIds, ...measures } = turnRow({})
		return { traceCount: "1", ...measures, ...overrides }
	}

	/** Two reads: the turn rows under `GROUP BY`, the session's row without. */
	const summaryHarness = (
		rows: ReadonlyArray<Record<string, unknown>>,
		totals: ReadonlyArray<Record<string, unknown>>,
	) => {
		const sqls: string[] = []
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				const sql = compiledQueryOf(compiled).sql
				sqls.push(sql)
				return compiledQueryOf(compiled)
					.decodeRows(sql.includes("GROUP BY turnKey") ? rows : totals)
					.pipe(Effect.orDie)
			},
		})
		return { harness, sqls }
	}

	it("reports the session's own row as the totals, and the turn rows beside it", async () => {
		const { harness, sqls } = summaryHarness(
			[
				turnRow({ inputTokens: "300", llmInputTokens: "150", outputTokens: "60", llmOutputTokens: "30" }),
				turnRow({
					turnKey: "turn_1",
					conversationId: "turn_1",
					traceIds: [TRACE_ID, "0123456789abcdef0123456789abcdef"],
					startTime: "2026-08-19 10:00:20.000000000",
					endTime: "2026-08-19 10:00:35.500000000",
					errorSpanCount: "1",
					inputTokens: "100",
					llmInputTokens: "100",
					models: ["gpt-5", "claude-opus-5"],
					agentNames: [],
				}),
			],
			[
				// Usage reported per model call AND rolled up onto the agent span:
				// the per-call figures are the total, the roll-up is not added on top.
				totalsRow({
					traceCount: "2",
					spanCount: "80",
					aiSpanCount: "12",
					llmCalls: "6",
					toolCalls: "4",
					errorSpanCount: "1",
					endTime: "2026-08-19 10:00:35.500000000",
					durationMs: "35500",
					inputTokens: "400",
					llmInputTokens: "250",
					outputTokens: "60",
					llmOutputTokens: "30",
					costReporters: "4",
					cost: "0.02",
					llmCost: "0.01",
					models: ["gpt-5", "claude-opus-5"],
				}),
			],
		)
		try {
			const response = await harness.post("/internal/ai-sessions/summary", SPANS_BODY)
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({
				spanCount: 80,
				aiSpanCount: 12,
				traceCount: 2,
				startTime: "2026-08-19 10:00:00.000000000",
				endTime: "2026-08-19 10:00:35.500000000",
				durationMs: 35_500,
				llmCalls: 6,
				toolCalls: 4,
				errorSpanCount: 1,
				tokens: { input: 250, output: 30, cacheRead: 0 },
				tokenReporting: "per-call",
				cost: 0.01,
				models: ["gpt-5", "claude-opus-5"],
				agentNames: ["slack-agent"],
				turnsTruncated: false,
			})
			const turns = response.body.turns as Array<Record<string, unknown>>
			expect(turns).toHaveLength(2)
			expect(turns[1]).toMatchObject({ turnKey: "turn_1", tokens: { input: 100, output: 0, cacheRead: 0 } })
			expect(turns[1]).not.toHaveProperty("cost")
			expect(sqls).toHaveLength(2)
			for (const sql of sqls) expect(sql).toContain(`SpanAttributes['maple_ai.session.id'] = '${SESSION_ID}'`)
		} finally {
			await harness.dispose()
		}
	})

	// The rule is applied to the session's row, never to the turn rows summed:
	// a turn span's roll-up and its model calls can land in different rows.
	it("does not double usage split across a turn row and its trace's row", async () => {
		const { harness } = summaryHarness(
			[
				turnRow({ inputTokens: "300", llmCalls: "0" }),
				turnRow({ turnKey: TRACE_ID, conversationId: "", inputTokens: "300", llmInputTokens: "300" }),
			],
			[totalsRow({ inputTokens: "600", llmInputTokens: "300" })],
		)
		try {
			const response = await harness.post("/internal/ai-sessions/summary", SPANS_BODY)
			expect(response.body).toMatchObject({ tokens: { input: 300, output: 0, cacheRead: 0 }, tokenReporting: "per-call" })
		} finally {
			await harness.dispose()
		}
	})

	it("counts a roll-up when no model call reported usage", async () => {
		const { harness } = summaryHarness(
			[turnRow({ inputTokens: "300", outputTokens: "60" })],
			[totalsRow({ inputTokens: "300", outputTokens: "60" })],
		)
		try {
			const response = await harness.post("/internal/ai-sessions/summary", SPANS_BODY)
			expect(response.body).toMatchObject({
				tokens: { input: 300, output: 60, cacheRead: 0 },
				tokenReporting: "roll-up",
			})
			expect(response.body).not.toHaveProperty("cost")
		} finally {
			await harness.dispose()
		}
	})

	it("keeps exact totals when the turn list is cut", async () => {
		const rows = Array.from({ length: AI_SESSION_SUMMARY_MAX_TURNS + 1 }, (_, index) =>
			turnRow({ turnKey: `turn_${index}`, conversationId: `turn_${index}`, spanCount: "1" }),
		)
		const { harness } = summaryHarness(rows, [totalsRow({ spanCount: String(AI_SESSION_SUMMARY_MAX_TURNS + 1) })])
		try {
			const response = await harness.post("/internal/ai-sessions/summary", SPANS_BODY)
			expect(response.body).toMatchObject({ spanCount: AI_SESSION_SUMMARY_MAX_TURNS + 1, turnsTruncated: true })
			expect(response.body.turns).toHaveLength(AI_SESSION_SUMMARY_MAX_TURNS)
		} finally {
			await harness.dispose()
		}
	})

	it("answers an unknown session with empty totals and no bounds", async () => {
		// An aggregate over no rows is still one row, with a zero count.
		const { harness } = summaryHarness([], [totalsRow({ spanCount: "0", traceCount: "0" })])
		try {
			const response = await harness.post("/internal/ai-sessions/summary", SPANS_BODY)
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({ spanCount: 0, turns: [], tokenReporting: "none" })
			expect(response.body).not.toHaveProperty("startTime")
		} finally {
			await harness.dispose()
		}
	})
})

// ---------------------------------------------------------------------------
// Agent Sessions › Tools
// ---------------------------------------------------------------------------

const TOOLS_WINDOW = { startTime: "2026-08-19 09:00:00", endTime: "2026-08-19 11:00:00" }

/** One row of the tools measures, in the wire shape the derived row schema decodes. */
const toolsMeasures = { calls: 12, sessions: 3, errors: 1, p50: 1_500_000, p90: 9_000_000, p95: 12_000_000 }

describe("POST /internal/ai-sessions/tools/series", () => {
	// The series key is derived from the selection on BOTH sides — the query
	// picks the column, the handler reports which one. If the two ever disagree
	// the chart's legend names a dimension its points are not keyed by, behind a
	// 200 that looks perfectly healthy.
	it("reports the series kind the query actually keyed on", async () => {
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([{ bucket: "2026-08-19T09:00:00.000Z", seriesKey: "gpt-5", ...toolsMeasures }])
					.pipe(Effect.orDie),
		})

		try {
			const perTool = await harness.post("/internal/ai-sessions/tools/series", {
				...TOOLS_WINDOW,
				bucketSeconds: 300,
			})
			expect(perTool.status).toBe(200)
			expect(perTool.body.seriesKind).toBe("tool")

			// A tool picked and no model: the chart now compares the models that
			// tool ran under.
			const perModel = await harness.post("/internal/ai-sessions/tools/series", {
				...TOOLS_WINDOW,
				bucketSeconds: 300,
				tool: "search_traces",
			})
			expect(perModel.body.seriesKind).toBe("model")
			expect(perModel.body.data).toHaveLength(1)

			// Both picked is one series, named by the tool.
			const single = await harness.post("/internal/ai-sessions/tools/series", {
				...TOOLS_WINDOW,
				bucketSeconds: 300,
				tool: "search_traces",
				model: "gpt-5",
			})
			expect(single.body.seriesKind).toBe("tool")
		} finally {
			await harness.dispose()
		}
	})

	it("refuses a fractional bucket rather than failing in the builder", async () => {
		const harness = makeHarness({})

		try {
			// `param.int` rejects a fraction while the query is still being built,
			// which would surface as a 500. The schema makes it a 400.
			const response = await harness.post("/internal/ai-sessions/tools/series", {
				...TOOLS_WINDOW,
				bucketSeconds: 1.5,
			})
			expect(response.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/tools/totals", () => {
	it("compares against the window of equal length that ends where this one starts", async () => {
		const seen: string[] = []
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				seen.push(compiledQueryOf(compiled).sql)
				return compiledQueryOf(compiled)
					.decodeRows([
						{ period: "current", ...toolsMeasures },
						{ period: "previous", ...toolsMeasures, calls: 4 },
					])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/tools/totals", TOOLS_WINDOW)
			expect(response.status).toBe(200)
			// The two-hour window, shifted back two hours — computed here rather
			// than asked for, so a delta cannot be taken against a different span.
			expect(seen[0]).toContain("'2026-08-19 07:00:00'")
			expect(seen[0]).toContain("'2026-08-19 09:00:00'")
			expect(response.body.current).toEqual(toolsMeasures)
			expect(response.body.previous).toEqual({ ...toolsMeasures, calls: 4 })
		} finally {
			await harness.dispose()
		}
	})

	it("answers zeros for a period the union returned no row for", async () => {
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([{ period: "current", ...toolsMeasures }])
					.pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/tools/totals", TOOLS_WINDOW)
			expect(response.body.previous).toEqual({ calls: 0, sessions: 0, errors: 0, p50: 0, p90: 0, p95: 0 })
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/tools/breakdowns", () => {
	// Same failure mode as the facets split: `panel("tool")` here and
	// `branch("tool", …)` in the query are two independent literals in two
	// packages, and a drift empties both panels behind a 200.
	it("splits one union result into the two panels", async () => {
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([
						{ kind: "tool", key: "search_traces", ...toolsMeasures, lastSeen: "2026-08-19 10:59:00" },
						{ kind: "model", key: "gpt-5", ...toolsMeasures, lastSeen: "2026-08-19 10:58:00" },
						{ kind: "tool", key: "run_sql", ...toolsMeasures, lastSeen: "2026-08-19 10:57:00" },
					])
					.pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/tools/breakdowns", TOOLS_WINDOW)
			expect(response.status).toBe(200)
			expect((response.body.tools as ReadonlyArray<{ key: string }>).map((row) => row.key)).toEqual([
				"search_traces",
				"run_sql",
			])
			expect((response.body.models as ReadonlyArray<{ key: string }>).map((row) => row.key)).toEqual([
				"gpt-5",
			])
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/tools/sessions", () => {
	it("returns the selection's sessions with the list page's own key", async () => {
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([
						{
							sessionId: `trace:${TRACE_ID}`,
							agentName: "slack-agent",
							model: "gpt-5",
							serviceName: "agent-runner",
							calls: 9,
							errors: 2,
							avgDurationNs: 2_500_000,
							maxDurationNs: 11_000_000,
							startedAt: "2026-08-19 09:14:02.125000000",
						},
					])
					.pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/tools/sessions", {
				...TOOLS_WINDOW,
				tool: "search_traces",
				limit: 10,
			})
			expect(response.status).toBe(200)
			// A `trace:` id, unchanged — the drill-in links straight back to the
			// sessions page, which resolves exactly this key.
			expect((response.body.data as ReadonlyArray<{ sessionId: string }>)[0]?.sessionId).toBe(
				`trace:${TRACE_ID}`,
			)
		} finally {
			await harness.dispose()
		}
	})
})

describe("the tools toolbar's two predicates", () => {
	// `search` and `failingOnly` are the only tools fields that are not facet
	// values, and the only ones a handler could plausibly drop on the way to the
	// query. Dropped, every read would answer for a wider population than the
	// toolbar says — a 200 whose tiles disagree with its own tables.
	it("reaches the SQL of all four reads", async () => {
		const seen: string[] = []
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				seen.push(compiledQueryOf(compiled).sql)
				return compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie)
			},
		})

		const scope = { ...TOOLS_WINDOW, search: "run_sql", failingOnly: true }

		try {
			for (const [path, payload] of [
				["/internal/ai-sessions/tools/series", { ...scope, bucketSeconds: 300 }],
				["/internal/ai-sessions/tools/totals", scope],
				["/internal/ai-sessions/tools/breakdowns", scope],
				["/internal/ai-sessions/tools/sessions", scope],
			] as const) {
				const response = await harness.post(path, payload)
				expect(response.status, path).toBe(200)
			}

			expect(seen).toHaveLength(4)
			for (const sql of seen) {
				// The `_` is escaped, so the needle is a literal rather than a
				// single-character wildcard.
				expect(sql).toContain("ToolName ILIKE '%run\\\\_sql%'")
				expect(sql).toContain("ai_trace_index.IsError = 1")
			}
		} finally {
			await harness.dispose()
		}
	})

	it("refuses an empty needle rather than searching for everything", async () => {
		const harness = makeHarness({})

		try {
			const response = await harness.post("/internal/ai-sessions/tools/breakdowns", {
				...TOOLS_WINDOW,
				search: "",
			})
			expect(response.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})
})
