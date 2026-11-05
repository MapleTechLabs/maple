import { describe, expect, it } from "vitest"
import { Array as Arr, DateTime } from "effect"
import {
	bucketActivity,
	eventDetail,
	issueItem,
	mcpServersInScope,
	mergeActivity,
	mergeServices,
	resolveUsersScope,
	severityOf,
	signalsOf,
	sliceWindow,
} from "./users-reads"

const rows = [
	{ service: "web", namespace: "storefront" },
	{ service: "api", namespace: "platform" },
	{ service: "web", namespace: "checkout" },
]

describe("resolveUsersScope", () => {
	it("scopes to every service that emitted under a picked namespace", () => {
		const scope = resolveUsersScope(["checkout", "platform"], rows, ["mcp"])
		expect(scope.services).toEqual(["api", "web"])
		expect(scope.mcpServices).toEqual(["mcp"])
	})

	it("labels a service with its busiest namespace", () => {
		expect(resolveUsersScope([], rows, []).serviceNamespaces).toEqual([
			["web", "storefront"],
			["api", "platform"],
		])
	})

	it("resolves no services for a namespace nothing emitted under", () => {
		expect(resolveUsersScope(["nowhere"], rows, []).services).toEqual([])
	})
})

describe("signalsOf", () => {
	it("lists the sources that saw the user", () => {
		expect(signalsOf({ sessions: 2, events: 0, mcpSpans: 5 })).toEqual(["replay", "mcp"])
		expect(signalsOf({ sessions: 0, events: 1, mcpSpans: 0 })).toEqual(["events"])
		expect(signalsOf({ sessions: 0, events: 0, mcpSpans: 3, spans: 3, logLines: 0 })).toEqual(["mcp"])
		expect(signalsOf({ sessions: 0, events: 0, mcpSpans: 0, spans: 4, logLines: 2 })).toEqual([
			"traces",
			"logs",
		])
	})
})

describe("mcpServersInScope", () => {
	const scope = resolveUsersScope([], rows, ["api", "mcp"])

	it("reads every MCP server when unscoped", () => {
		expect(mcpServersInScope(scope)).toEqual(["api", "mcp"])
	})

	it("keeps the MCP servers that emitted under the picked namespace", () => {
		expect(mcpServersInScope(resolveUsersScope(["platform"], rows, ["api", "mcp"]))).toEqual(["api"])
	})
})

describe("eventDetail", () => {
	it("prefers the page, else names the first properties", () => {
		expect(eventDetail("/checkout", ["plan"], ["pro"])).toBe("/checkout")
		expect(eventDetail("", ["a", "b", "c", "d"], ["1", "2", "3", "4"])).toBe("a=1, b=2, c=3")
	})
})

describe("mergeActivity", () => {
	const session = {
		sessionId: "s1",
		service: "web",
		startedMs: 1_000,
		durationMs: 60_000,
		pages: 3,
		errors: 1,
		entryPath: "/pricing",
		device: "Chrome · macOS",
	}
	const event = { atMs: 3_000, name: "plan_upgraded", source: "server", service: "api", detail: "plan=pro" }
	const mcpSession = {
		service: "maple-ai",
		sessionId: "user:2000:Q2xhdWRl:dXNlcg",
		source: "user" as const,
		client: "Claude Code",
		kind: "agent" as const,
		requests: 9,
		calls: 1,
		errors: 0,
		tools: 1,
		firstSeenMs: 2_000,
		lastSeenMs: 9_000,
	}

	it("merges every source newest first, an MCP session at its start", () => {
		const items = mergeActivity({ sessions: [session], events: [event], mcpSessions: [mcpSession] })
		expect(Arr.map(items, (item) => [item.kind, item.atMs])).toEqual([
			["event", 3_000],
			["mcp", 2_000],
			["session", 1_000],
		])
	})

	it("links sessions and MCP sessions to their pages and marks failures", () => {
		const [eventItem, mcpItem, sessionItem] = mergeActivity({
			sessions: [session],
			events: [event],
			mcpSessions: [mcpSession],
		})
		expect(eventItem?.sessionId).toBeNull()
		expect(mcpItem).toMatchObject({
			sessionId: mcpSession.sessionId,
			service: "maple-ai",
			title: "1 tool call from Claude Code",
			tone: "neutral",
		})
		expect(sessionItem).toMatchObject({ sessionId: "s1", title: "Session on /pricing", tone: "crit" })
	})

	it("keeps the latest rows when capped", () => {
		const items = mergeActivity({ sessions: [session], events: [event], mcpSessions: [mcpSession] }, 2)
		expect(Arr.map(items, (item) => item.kind)).toEqual(["event", "mcp"])
	})

	it("adds failed and slow requests and warnings, each opening its trace", () => {
		const trace = (atMs: number, status: string, durationMs: number) => ({
			traceId: `t${atMs}`,
			spanId: "s",
			atMs,
			spanName: "POST /checkout",
			service: "api",
			durationMs,
			status,
			isRoot: true,
		})
		const items = mergeActivity({
			sessions: [],
			events: [],
			mcpSessions: [],
			traces: [trace(5_000, "Error", 120), trace(4_000, "Ok", 2_400)],
			logs: [{ atMs: 6_000, severity: "WARN", service: "api", body: "card declined", traceId: "" }],
		})
		expect(Arr.map(items, (item) => [item.kind, item.tone, item.traceId])).toEqual([
			["log", "warn", null],
			["request", "crit", "t5000"],
			["request", "warn", "t4000"],
		])
		expect(items[1]?.detail).toBe("Failed · 120 ms · api")
	})
})

describe("bucketActivity", () => {
	const window = { startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2026, 10, 8) }
	const hour = (day: number, h: number) => Date.UTC(2026, 10, day, h) / 1000

	it("sums each hour's requests into its day of a week window, oldest first", () => {
		expect(bucketActivity([hour(1, 3), hour(1, 9), hour(7, 23)], [2, 3, 5], window)).toEqual([
			5, 0, 0, 0, 0, 0, 5,
		])
	})

	it("puts an hour floored before the window start into the first slice", () => {
		expect(
			bucketActivity([hour(1, 0) - 1800], [4], { ...window, startMs: window.startMs - 1000 })[0],
		).toBe(4)
	})
})

describe("sliceWindow", () => {
	const hours = (serviceName: string, first: string, last: string) => ({
		serviceName,
		firstHour: DateTime.makeUnsafe(first),
		lastHour: DateTime.makeUnsafe(last),
	})
	const window = { startTime: "2026-11-01 00:20:00", endTime: "2026-11-02 00:00:00" }

	it("narrows the raw read to the services and the hours they span inside the window", () => {
		expect(
			sliceWindow(
				[
					hours("api", "2026-11-01T05:00:00Z", "2026-11-01T05:00:00Z"),
					hours("web", "2026-11-01T00:00:00Z", "2026-11-01T05:00:00Z"),
				],
				window,
			),
		).toEqual({
			serviceNames: ["api", "web"],
			startTime: "2026-11-01 00:20:00",
			endTime: "2026-11-01 06:00:00",
		})
	})

	it("reads nothing raw when no slice holds the signal", () => {
		expect(sliceWindow([], window)).toBeNull()
	})
})

describe("mergeServices", () => {
	it("adds the rollup's requests and logs, keeping the larger count on an MCP server", () => {
		const rollup = (
			serviceName: string,
			serviceNamespace: string,
			requestCount: number,
			logCount: number,
		) => ({
			serviceName,
			serviceNamespace,
			requestCount,
			failedRequestCount: 0,
			errorSpanCount: 0,
			logCount,
			lastSeen: DateTime.makeUnsafe(0),
		})
		expect(
			mergeServices(
				[
					{ service: "web", namespace: "storefront", signals: 4 },
					{ service: "docs-mcp", namespace: "platform", signals: 6 },
				],
				[rollup("docs-mcp", "platform", 6, 0), rollup("api", "platform", 9, 3)],
				["docs-mcp"],
			),
		).toEqual([
			{ service: "api", namespace: "platform", signals: 12 },
			{ service: "docs-mcp", namespace: "platform", signals: 6 },
			{ service: "web", namespace: "storefront", signals: 4 },
		])
	})
})

describe("severityOf", () => {
	it("keeps the SDK's text, else names the OTel level of the number", () => {
		expect(severityOf("Warning", 13)).toBe("Warning")
		expect(severityOf("", 13)).toBe("WARN")
		expect(severityOf("", 17)).toBe("ERROR")
		expect(severityOf("", 24)).toBe("FATAL")
		expect(severityOf("", 0)).toBe("UNSPECIFIED")
	})
})

describe("issueItem", () => {
	const issue = {
		issueId: null,
		fingerprintHash: "123",
		type: "",
		message: "",
		service: "api",
		hits: 2,
		firstSeenMs: 0,
		lastSeenMs: 1,
		status: null,
	}

	it("titles a timeline error by its type, else its message, else as the Errors tab does", () => {
		expect(issueItem({ ...issue, type: "TypeError", message: "x is undefined" }).title).toBe("TypeError")
		expect(issueItem({ ...issue, message: "upstream timed out" }).title).toBe("upstream timed out")
		expect(issueItem(issue).title).toBe("Unknown Error")
	})
})
