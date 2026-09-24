import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	GetSessionTracesOutput,
	GetSessionTranscriptOutput,
	SearchSessionsOutput,
} from "@maple/domain/mcp-outputs"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import type { McpToolResult } from "../types"

// The three browser-session tools through the registry, against rows in their wire shapes:
// ClickHouse sends integer aggregates as strings, which every tool coerces at the edge.

const SESSION_ID = "sess_browser_1"
const MISSING_SESSION_ID = "sess_missing"
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"

const replayRow = {
	sessionId: SESSION_ID,
	startTime: "2026-09-24 10:00:00",
	endTime: "2026-09-24 10:05:00",
	durationMs: "300000",
	status: "ended",
	lastActivityAt: "2026-09-24 10:05:00",
	userId: "4632",
	userName: "Ada",
	userEmail: "ada@acme.com",
	groupId: "g1",
	groupName: "Acme",
	visitorId: "v1",
	utmSource: "",
	entryPath: "/checkout",
	urlInitial: "https://shop.example/checkout",
	userAgent: "Mozilla",
	browserName: "Chrome",
	osName: "macOS",
	deviceType: "desktop",
	country: "DE",
	serviceName: "web",
	pageViews: "3",
	clickCount: "7",
	errorCount: "2",
	traceCount: "1",
	traceIds: [TRACE_ID],
	resourceAttributes: "{}",
	version: 1,
	recorded: "true",
	visitorIsNew: 0,
	userTraits: "{}",
	referrer: "",
	referrerHost: "",
	utmMedium: "",
	utmCampaign: "",
	utmTerm: "",
	utmContent: "",
	host: "shop.example",
	exitPath: "/checkout",
	language: "en",
}

const eventRow = (seq: number, type: string, extra: Record<string, unknown>) => ({
	timestamp: `2026-09-24 10:00:0${seq}`,
	seq,
	type,
	url: "https://shop.example/checkout",
	traceId: TRACE_ID,
	level: "",
	message: "",
	targetSelector: "",
	targetText: "",
	netMethod: "",
	netUrl: "",
	netStatus: 0,
	netDurationMs: 0,
	errorStack: "",
	attributes: "{}",
	...extra,
})

const fixtures: FixtureRule[] = [
	{ match: (sql) => sql.includes(MISSING_SESSION_ID), rows: [] },
	{
		match: (sql) => sql.includes("session_events") && sql.includes("TargetSelector"),
		rows: [
			eventRow(1, "click", { targetSelector: "button#pay", targetText: "Pay now" }),
			eventRow(2, "network", {
				netMethod: "POST",
				netUrl: "/api/pay",
				netStatus: 500,
				netDurationMs: 120,
			}),
		],
	},
	{
		match: (sql) => sql.includes("session_events"),
		rows: [{ sessionId: SESSION_ID, activeTimeMs: "4000", idleTimeMs: "1000", eventCount: "2" }],
	},
	{
		match: (sql) => sql.includes("trace_detail_spans"),
		rows: [
			{
				traceId: TRACE_ID,
				startTime: "2026-09-24 10:00:02",
				durationMs: "118.5",
				rootSpanName: "POST /api/pay",
				rootServiceName: "api",
				rootSpanKind: "SPAN_KIND_SERVER",
				rootSpanAttributes: "{}",
				spanCount: "4",
				hasError: "1",
			},
		],
	},
	{ match: (sql) => sql.includes("session_replays"), rows: [replayRow] },
]

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse(fixtures)
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: Record<string, unknown>) =>
	runToolDirect(rt, name, params) as Promise<McpToolResult>

describe("search_sessions", () => {
	it("returns typed rows and renders the identified user", async () => {
		const result = await call("search_sessions", { has_errors: "true" })
		const output = Schema.decodeUnknownSync(SearchSessionsOutput)(result.structuredContent)
		expect(output.sessions[0]?.errorCount).toBe(2)
		expect(output.filters).toEqual({ hasErrors: true })
		const text = markdown(result)
		expect(text).toContain(`| ${SESSION_ID} | Ada |`)
		expect(text).toContain(`\`get_session_transcript session_id="${SESSION_ID}"\``)
	})

	it("offers the next page with the same filters when the page is full", async () => {
		const text = markdown(await call("search_sessions", { service_name: "web", limit: 1 }))
		expect(text).toMatch(
			/Next page: `search_sessions start_time="[^"]+" end_time="[^"]+" service="web" limit=1 offset=1`/,
		)
	})
})

describe("get_session_transcript", () => {
	it("renders the events and rejects an unknown event type", async () => {
		const result = await call("get_session_transcript", {
			session_id: SESSION_ID,
			event_types: "click,network",
		})
		const output = Schema.decodeUnknownSync(GetSessionTranscriptOutput)(result.structuredContent)
		expect(output.filters.eventTypes).toEqual(["click", "network"])
		const text = markdown(result)
		expect(text).toContain('CLICK button#pay "Pay now"')
		expect(text).toContain("NET   POST 500 /api/pay (120ms)")
		// The first event's timestamp rides along so `inspect_trace` prunes to the right day.
		expect(text).toMatch(
			new RegExp(`\\\`inspect_trace trace_id="${TRACE_ID}" timestamp="2026-09-24 10:00:0\\d"\\\``),
		)

		const bad = await call("get_session_transcript", { session_id: SESSION_ID, event_types: ["clicks"] })
		expect(bad.isError).toBe(true)
		expect(markdown(bad)).toContain("Invalid parameters for `get_session_transcript`")
	})
})

describe("get_session_traces", () => {
	it("renders the session and its errored trace first", async () => {
		const result = await call("get_session_traces", { session_id: SESSION_ID })
		const output = Schema.decodeUnknownSync(GetSessionTracesOutput)(result.structuredContent)
		expect(output.traces[0]?.hasError).toBe(true)
		const text = markdown(result)
		expect(text).toContain("### Backend traces")
		expect(text).toContain(
			`\`inspect_trace trace_id="${TRACE_ID}" timestamp="2026-09-24 10:00:02"\`: errored POST /api/pay in api`,
		)
	})

	it("reports an unknown session as invalid input", async () => {
		const result = await call("get_session_traces", { session_id: MISSING_SESSION_ID })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Invalid input (`session_id`)")
	})
})
