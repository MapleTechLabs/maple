import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import {
	USER_SESSION_GAP_MS,
	agentSessionsOf,
	clientItems,
	parseUserSessionKey,
	quietClientsFor,
	stitchUserSessions,
	userSessionKey,
} from "./mcp-reads"

const seen = (client: string, kind: string, connects: number, sources: number, calls = 0) => ({
	client,
	kind,
	calls,
	connects,
	sources,
	lastSeen: DateTime.makeUnsafe(Date.UTC(2026, 10, 1, 12, 0)),
})

const reach = [
	seen("Claude Code", "agent", 620, 25, 242),
	seen("curl", "script", 0, 3, 2283),
	seen("executor", "internal", 45, 1),
]
const calls = [
	{ client: "curl", kind: "script", calls: 2283, errors: 8 },
	{ client: "Claude Code", kind: "agent", calls: 242, errors: 12 },
]

describe("clientItems", () => {
	it("gives each caller its connects and sources", () => {
		expect(clientItems(calls, reach)[1]).toMatchObject({
			name: "Claude Code",
			calls: 242,
			connects: 620,
			sources: 25,
			lastSeenMs: Date.UTC(2026, 10, 1, 12, 0),
		})
	})

	it("lists a client that connected without calling a tool after the callers, once", () => {
		const items = clientItems(calls, reach, reach)
		expect(items.map((item) => [item.name, item.calls])).toEqual([
			["curl", 2283],
			["Claude Code", 242],
			["executor", 0],
		])
		expect(items[2]).toMatchObject({ kind: "internal", connects: 45, errors: 0 })
	})

	it("never files a caller past the calls read's limit as connected without calling", () => {
		const items = clientItems(calls, reach, [...reach, seen("Cursor", "agent", 3, 1, 7)])
		expect(items.map((item) => item.name)).not.toContain("Cursor")
	})

	it("never lists a client that only listed tools as connected", () => {
		const items = clientItems(calls, reach, [seen("probe", "unknown", 0, 1)])
		expect(items.map((item) => item.name)).not.toContain("probe")
	})

	it("reads an unrecognised kind as unknown and a client without reach as unseen", () => {
		expect(clientItems([{ client: "mystery", kind: "robot", calls: 1, errors: 0 }])[0]).toMatchObject({
			kind: "unknown",
			connects: 0,
			sources: 0,
			lastSeenMs: 0,
		})
	})
})

describe("quietClientsFor", () => {
	const names = (rows: ReadonlyArray<{ client: string }>) => rows.map((row) => row.client)

	it("keeps every reach row with no selection", () => {
		expect(names(quietClientsFor(reach, {}))).toEqual(["Claude Code", "curl", "executor"])
	})

	it("narrows to the selected client and kind", () => {
		expect(names(quietClientsFor(reach, { kind: "internal" }))).toEqual(["executor"])
		expect(names(quietClientsFor(reach, { client: "curl" }))).toEqual(["curl"])
	})

	it("drops them all under a tool search or failing-only, which only tool calls match", () => {
		expect(quietClientsFor(reach, { search: "sql" })).toEqual([])
		expect(quietClientsFor(reach, { failingOnly: true })).toEqual([])
	})
})

describe("agentSessionsOf", () => {
	const agentTrace = "a".repeat(32)
	const httpTrace = "b".repeat(32)
	const filed = [{ traceId: agentTrace, sessionId: "claude-session-1" }]

	it("files a call parented by `params._meta` under its own trace's session", () => {
		expect(agentSessionsOf([{ traceId: agentTrace, linkTraceId: httpTrace }], filed)).toEqual([
			"claude-session-1",
		])
	})

	it("falls back to the linked trace on a server that only links the caller", () => {
		expect(agentSessionsOf([{ traceId: httpTrace, linkTraceId: agentTrace }], filed)).toEqual([
			"claude-session-1",
		])
	})

	it("leaves a call whose caller propagated no agent trace unlinked", () => {
		expect(agentSessionsOf([{ traceId: httpTrace, linkTraceId: "" }], filed)).toEqual([null])
	})
})

describe("stitchUserSessions", () => {
	const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 2, 9, 0) + minute * 60_000)
	const minute = (
		user: string,
		client: string,
		m: number,
		extra: Partial<{ errors: number; tools: ReadonlyArray<string | null> }> = {},
	) => ({
		user,
		client,
		kind: "agent",
		userName: user === "u1" ? "Ada" : "",
		requests: 2,
		calls: 1,
		errors: extra.errors ?? 0,
		tools: extra.tools ?? ["run_sql"],
		firstSeen: at(m),
		lastSeen: DateTime.makeUnsafe(Date.UTC(2026, 10, 2, 9, 0) + m * 60_000 + 30_000),
	})

	it("joins a user's minutes from one client until they go quiet for the gap", () => {
		const gapMinutes = USER_SESSION_GAP_MS / 60_000
		const sessions = stitchUserSessions([
			minute("u1", "Claude Code", 0, { tools: ["run_sql", null] }),
			minute("u1", "Claude Code", 5, { errors: 1, tools: ["list_services"] }),
			// Quiet just under the gap since the last request (at 5m30s): still the same session.
			minute("u1", "Claude Code", 5 + gapMinutes - 1),
			// Quiet for the whole gap: a new session.
			minute("u1", "Claude Code", 5 + gapMinutes * 2 + 1),
		])
		expect(sessions.map((s) => [s.requests, s.calls, s.errors, s.tools])).toEqual([
			[6, 3, 1, 2],
			[2, 1, 0, 1],
		])
		expect(sessions[0]).toMatchObject({
			source: "user",
			user: "u1",
			userName: "Ada",
			client: "Claude Code",
		})
	})

	it("never joins two users or one user's two clients, whatever order the rows arrive in", () => {
		const sessions = stitchUserSessions([
			minute("u2", "Cursor", 1),
			minute("u1", "Cursor", 1),
			minute("u1", "Claude Code", 2),
			minute("u1", "Claude Code", 0),
		])
		expect(sessions.map((s) => `${s.user} ${s.client}`)).toEqual([
			"u1 Claude Code",
			"u1 Cursor",
			"u2 Cursor",
		])
		expect(sessions[2]?.userName).toBeNull()
	})

	it("keys each session so its page can find it again", () => {
		const [session] = stitchUserSessions([minute("auth0|abc:1", "Node (undici)", 0)])
		expect(session === undefined ? undefined : parseUserSessionKey(session.sessionId)).toEqual({
			startMs: Date.UTC(2026, 10, 2, 9, 0),
			client: "Node (undici)",
			user: "auth0|abc:1",
		})
	})
})

describe("parseUserSessionKey", () => {
	it("reads an issued session id as no user session", () => {
		expect(parseUserSessionKey("3f6c1d2a-8b4e-4f7a-9c21-5d0e7b9a4c11")).toBeUndefined()
	})

	it("refuses a key whose start, client or user is missing or malformed", () => {
		expect(parseUserSessionKey("user:abc:Cursor:u1")).toBeUndefined()
		expect(parseUserSessionKey("user:1700000000000::u1")).toBeUndefined()
		expect(parseUserSessionKey(`user:${"9".repeat(20)}:QQ:QQ`)).toBeUndefined()
		expect(parseUserSessionKey("user:1700000000000:Cursor:")).toBeUndefined()
		expect(parseUserSessionKey("user:1700000000000:%E0%A4%A:u1")).toBeUndefined()
	})

	it("round-trips ids with separators, slashes and non-ASCII, keeping them out of the key", () => {
		const user = "https://issuer.example/users/42:ü%2F"
		const key = userSessionKey(1, "a:b", user)
		expect(key).not.toMatch(/[/%]/)
		expect(parseUserSessionKey(key)).toEqual({ startMs: 1, client: "a:b", user })
	})
})
