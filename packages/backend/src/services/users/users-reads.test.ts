import { describe, expect, it } from "vitest"
import { eventDetail, mcpServersInScope, mergeActivity, resolveUsersScope, signalsOf } from "./users-reads"

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
		const items = mergeActivity([session], [event], [mcpSession])
		expect(items.map((item) => [item.kind, item.atMs])).toEqual([
			["event", 3_000],
			["mcp", 2_000],
			["session", 1_000],
		])
	})

	it("links sessions and MCP sessions to their pages and marks failures", () => {
		const [eventItem, mcpItem, sessionItem] = mergeActivity([session], [event], [mcpSession])
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
		const items = mergeActivity([session], [event], [mcpSession], 2)
		expect(items.map((item) => item.kind)).toEqual(["event", "mcp"])
	})
})
