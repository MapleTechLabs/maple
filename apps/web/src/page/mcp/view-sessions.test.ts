import type { McpSessionRequestItem } from "@maple/domain/http"
import { describe, expect, it } from "vitest"
import { linkedAgentSessions, sessionToolsOf } from "./view-sessions"

const request = (overrides: Partial<McpSessionRequestItem>): McpSessionRequestItem => ({
	timeMs: 0,
	method: "tools/call",
	tool: "run_sql",
	requestId: "1",
	durationNs: 1_000_000,
	errorType: null,
	message: null,
	traceId: "t",
	spanId: "s",
	agentSessionId: null,
	...overrides,
})

describe("linkedAgentSessions", () => {
	it("lists each linked Agent Session once, the most requests first", () => {
		const rows = [
			request({ agentSessionId: "a" }),
			request({ agentSessionId: "b" }),
			request({ agentSessionId: "b" }),
			request({}),
		]
		expect(linkedAgentSessions(rows)).toEqual([
			{ sessionId: "b", requests: 2 },
			{ sessionId: "a", requests: 1 },
		])
	})
})

describe("sessionToolsOf", () => {
	it("totals tool calls per tool and leaves the protocol requests out", () => {
		const rows = [
			request({ method: "initialize", tool: null }),
			request({ method: "tools/list", tool: null }),
			request({ tool: "run_sql", durationNs: 2_000_000 }),
			request({ tool: "run_sql", errorType: "tool_error", durationNs: 3_000_000 }),
			request({ tool: "list_services" }),
			request({ tool: null }),
		]
		expect(sessionToolsOf(rows)).toEqual([
			{ tool: "run_sql", calls: 2, errors: 1, durationNs: 5_000_000 },
			{ tool: "list_services", calls: 1, errors: 0, durationNs: 1_000_000 },
			{ tool: null, calls: 1, errors: 0, durationNs: 1_000_000 },
		])
	})
})
