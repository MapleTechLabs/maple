import type { McpSessionRequestItem } from "@maple/domain/http"
import { describe, expect, it } from "vitest"
import { linkedAgentSessions, medianLengthMs, sessionToolsOf, sessionUserLabel } from "./view-sessions"

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

describe("medianLengthMs", () => {
	const session = (lengthMs: number) => ({
		sessionId: String(lengthMs),
		source: "issued" as const,
		user: null,
		userName: null,
		client: "Cursor",
		kind: "agent" as const,
		requests: 1,
		calls: 1,
		errors: 0,
		tools: 1,
		firstSeenMs: 1_000,
		lastSeenMs: 1_000 + lengthMs,
	})

	it("takes the middle session's length, or the mean of the middle two", () => {
		expect(medianLengthMs([session(30), session(10), session(20)])).toBe(20)
		expect(medianLengthMs([session(40), session(10), session(20), session(30)])).toBe(25)
	})

	it("has no median without sessions", () => {
		expect(medianLengthMs([])).toBeUndefined()
	})
})

describe("sessionUserLabel", () => {
	it("keeps a named user without an id instead of calling them anonymous", () => {
		expect(sessionUserLabel(null, "Ada Lovelace")).toBe("Ada Lovelace")
		expect(sessionUserLabel("user_42", null)).toBe("user_42")
		expect(sessionUserLabel(null, null)).toBe("anonymous")
	})
})
