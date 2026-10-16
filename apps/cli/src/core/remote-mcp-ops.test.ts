import { beforeEach, describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { WarehouseQueryError } from "@maple/domain/http/warehouse-errors"
import { CliUsageError } from "../lib/errors"
import { describeFailure } from "../lib/failure"
import { makeMcpClient } from "./mcp-client"
import * as RemoteMcp from "./remote-mcp-ops"

// As in remote-ops.test.ts, assert the OUTBOUND request: the tool name and
// argument spelling are the contract with the server, and they are what drifts.

interface CapturedRequest {
	readonly url: string
	readonly method: string
	readonly authorization: string | null
	readonly accept: string | null
	readonly body: Record<string, unknown>
}

const decodeBody = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

interface StubReply {
	readonly status: number
	readonly body: unknown
}

let requests: Array<CapturedRequest> = []
let reply: StubReply = { status: 200, body: {} }

const fetchStub = Object.assign(
	async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request && init === undefined
				? input
				: new Request(input instanceof Request ? input.url : String(input), init)
		const text = await request.clone().text()
		requests.push({
			url: request.url,
			method: request.method.toUpperCase(),
			authorization: request.headers.get("authorization"),
			accept: request.headers.get("accept"),
			body: text.length > 0 ? decodeBody(JSON.parse(text)) : {},
		})
		return new Response(JSON.stringify(reply.body), {
			status: reply.status,
			headers: { "content-type": "application/json" },
		})
	},
	{ preconnect: globalThis.fetch.preconnect },
) satisfies typeof fetch

const toolResult = (structuredContent: unknown) => ({
	jsonrpc: "2.0",
	id: 1,
	result: { content: [{ type: "text", text: "rendered" }], structuredContent },
})

const toolError = (text: string) => ({
	jsonrpc: "2.0",
	id: 1,
	result: { isError: true, content: [{ type: "text", text }] },
})

const RANGE = { startTime: "2026-08-15 12:00:00", endTime: "2026-08-15 13:00:00" }
const TIME_RANGE = { start: RANGE.startTime, end: RANGE.endTime }

const run = <A, E>(f: (mcp: Effect.Success<ReturnType<typeof makeMcpClient>>) => Effect.Effect<A, E>) =>
	Effect.runPromise(
		Effect.flatMap(makeMcpClient("https://api.maple.test/", "maple_ak_testtoken"), f).pipe(
			Effect.provide(FetchHttpClient.layer),
			Effect.provideService(FetchHttpClient.Fetch, fetchStub),
		),
	)

const runFailure = <A, E>(
	f: (mcp: Effect.Success<ReturnType<typeof makeMcpClient>>) => Effect.Effect<A, E>,
) => run((mcp) => Effect.flip(f(mcp)))

beforeEach(() => {
	requests = []
	reply = { status: 200, body: {} }
})

describe("remote MCP transport", () => {
	it("POSTs one stateless tools/call to /mcp with the stored key", async () => {
		reply = { status: 200, body: toolResult({ timeRange: TIME_RANGE, identity: "all", errors: [] }) }
		await run((mcp) => RemoteMcp.findErrors(mcp, { range: RANGE, service: "api" }))

		expect(requests).toHaveLength(1)
		const [request] = requests
		expect(request!.url).toBe("https://api.maple.test/mcp")
		expect(request!.method).toBe("POST")
		expect(request!.authorization).toBe("Bearer maple_ak_testtoken")
		// The server answers 406 unless both are acceptable.
		expect(request!.accept).toContain("application/json")
		expect(request!.accept).toContain("text/event-stream")
		expect(request!.body).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			// Unset flags are left out rather than sent as null.
			params: {
				name: "find_errors",
				arguments: { start_time: RANGE.startTime, end_time: RANGE.endTime, service: "api" },
			},
		})
	})

	it("reports a tool's invalid-input failure as a usage error, without the agent hint", async () => {
		reply = {
			status: 200,
			body: toolError(
				"Invalid input (`sql`): SQL rejected (MissingOrgFilter): add $__orgFilter\nIf this looks like a bug in Maple rather than in your call, offer the user to report it with `send_maple_feedback`.",
			),
		}
		const error = await runFailure((mcp) => RemoteMcp.rawQuery(mcp, { sql: "SELECT 1", range: RANGE }))
		expect(error).toBeInstanceOf(CliUsageError)
		expect(error.message).toBe("Invalid input (`sql`): SQL rejected (MissingOrgFilter): add $__orgFilter")
	})

	it("reads a 401 as rejected credentials", async () => {
		reply = { status: 401, body: {} }
		const error = await runFailure((mcp) => RemoteMcp.findErrors(mcp, { range: RANGE }))
		expect(error).toBeInstanceOf(WarehouseQueryError)
		const report = describeFailure(error)
		expect(report.expected).toBe(true)
		expect(report.hint).toMatch(/maple login/)
	})

	it("fails loudly when the answer does not match the tool's output schema", async () => {
		reply = { status: 200, body: toolResult({ errors: "nope" }) }
		const error = await runFailure((mcp) => RemoteMcp.findErrors(mcp, { range: RANGE }))
		expect(error).toBeInstanceOf(WarehouseQueryError)
		expect(error.message).toMatch(/maple update/)
	})
})

describe("remote MCP operations map onto local output shapes", () => {
	it("slow traces become span rows, with the stats block local mode prints", async () => {
		reply = {
			status: 200,
			body: toolResult({
				timeRange: TIME_RANGE,
				stats: { p50Ms: 10, p95Ms: 90, minMs: 1, maxMs: 120 },
				traces: [
					{
						traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
						rootSpanName: "GET /checkout",
						durationMs: 120,
						spanCount: 1,
						services: ["api"],
						hasError: true,
						startTime: "2026-08-15 12:10:00",
					},
				],
			}),
		}
		const out = await run((mcp) => RemoteMcp.findSlowTraces(mcp, { range: RANGE, limit: 5 }))
		expect(requests[0]!.body.params).toMatchObject({ name: "find_slow_traces", arguments: { limit: 5 } })
		expect(out.timeRange).toEqual(RANGE)
		expect(out.stats).toEqual({ p50Ms: 10, p95Ms: 90, minMs: 1, maxMs: 120 })
		expect(out.traces[0]).toMatchObject({
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			spanName: "GET /checkout",
			serviceName: "api",
			statusCode: "Error",
			timestamp: "2026-08-15 12:10:00",
		})
	})

	it("span-name search sends the substring and the numeric offset", async () => {
		reply = {
			status: 200,
			body: toolResult({
				timeRange: TIME_RANGE,
				pagination: { offset: 20, limit: 20, hasMore: true, nextOffset: 40 },
				traces: [],
				filters: { spanName: "checkout", rootOnly: false },
				spanLevel: true,
			}),
		}
		const out = await run((mcp) =>
			RemoteMcp.searchTraces(mcp, { range: RANGE, spanName: "checkout", limit: 20, offset: 20 }),
		)
		expect(requests[0]!.body.params).toMatchObject({
			name: "search_traces",
			arguments: { span_name: "checkout", offset: 20, limit: 20 },
		})
		expect(out.pagination).toEqual({ offset: 20, limit: 20, hasMore: true })
	})

	it("log tools get WARN for the WARNING spelling, which they do not accept", async () => {
		reply = {
			status: 200,
			body: toolResult({ timeRange: TIME_RANGE, totalSampled: 0, sampleSize: 10000, patterns: [] }),
		}
		await run((mcp) => RemoteMcp.mineLogPatterns(mcp, { range: RANGE, severity: "WARNING" }))
		expect(requests[0]!.body.params).toMatchObject({
			name: "mine_log_patterns",
			arguments: { severity: "WARN" },
		})
	})

	it("compare emits one row per period with traffic, and no invented p99", async () => {
		reply = {
			status: 200,
			body: toolResult({
				currentPeriod: TIME_RANGE,
				previousPeriod: TIME_RANGE,
				overall: {
					current: { totalSpans: 200, totalErrors: 10, errorRate: 0.05 },
					previous: { totalSpans: 100, totalErrors: 0, errorRate: 0 },
				},
				services: [
					{
						name: "api",
						current: { throughput: 200, errorRate: 0.05, p95Ms: 40 },
						previous: { throughput: 0, errorRate: 0, p95Ms: 0 },
					},
				],
			}),
		}
		const rows = await run((mcp) =>
			RemoteMcp.compareServiceOverview(mcp, { current: RANGE, previous: RANGE }),
		)
		expect(rows).toEqual([
			{ period: "current", serviceName: "api", throughput: 200, errorCount: 10, p95LatencyMs: 40 },
		])
	})

	it("services attribute keys keep their facet type", async () => {
		reply = {
			status: 200,
			body: toolResult({
				source: "services",
				timeRange: TIME_RANGE,
				keys: [{ key: "environment:production", count: 3 }],
				environments: [{ name: "production", count: 3 }],
				commitShas: [{ name: "abc123", count: 1 }],
			}),
		}
		const keys = await run((mcp) => RemoteMcp.attributeKeys(mcp, { source: "services", range: RANGE }))
		expect(keys).toEqual([
			{ key: "environment:production", count: 3, facetType: "environment" },
			{ key: "commit_sha:abc123", count: 1, facetType: "commit_sha" },
		])
	})

	it("run_sql reports when the workspace cut the rows", async () => {
		reply = {
			status: 200,
			body: toolResult({
				expandedSql: "SELECT 1",
				rowCount: 250,
				columns: ["n"],
				rows: [{ n: 1 }],
				truncated: true,
				timeRange: TIME_RANGE,
			}),
		}
		const out = await run((mcp) =>
			RemoteMcp.rawQuery(mcp, { sql: "SELECT 1 FROM traces WHERE $__orgFilter", range: RANGE }),
		)
		expect(out).toEqual({ rows: [{ n: 1 }], truncatedFrom: 250 })
	})
})
