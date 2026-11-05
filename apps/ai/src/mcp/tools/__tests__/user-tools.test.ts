import { noFailedRequestsText } from "../inspect-user"
import { describe, expect, it } from "vitest"
import { Context, Effect, Layer, Schema, Array as Arr } from "effect"
import {
	ErrorIssueId,
	OrgId,
	RoleName,
	UserActivityResponse,
	UserId,
	UserIssuesResponse,
	UserOverviewResponse,
	UserProfileResponse,
	UsersListResponse,
	type UserDetailRequest,
	type UserListItem,
	type UserProfileItem,
	type UsersListRequest,
} from "@maple/domain/http"
import { InspectUserOutput, ListUsersOutput } from "@maple/domain/mcp-outputs"
import { UsersReadService } from "@maple/backend/services/users/UsersReadService"
import { CurrentMcpTenant } from "../../lib/query-warehouse"
import { executeRegisteredMcpToolUnscoped } from "../registry"
import type { McpToolResult } from "../types"

const WINDOW = { start_time: "2026-11-01 00:00:00", end_time: "2026-11-02 00:00:00" }
const ISSUE_ID = Schema.decodeSync(ErrorIssueId)("55555555-5555-4555-8555-555555555555")
const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
const AT = Date.UTC(2026, 10, 1, 12, 30)

const listUser = (userId: string, errors: number): UserListItem => ({
	userId,
	name: userId === "u_ada" ? "Ada Lovelace" : null,
	email: null,
	groupId: "acme",
	groupName: "Acme Inc.",
	namespaces: ["storefront"],
	firstSeenMs: AT - 3_600_000,
	lastSeenMs: AT,
	sessions: 2,
	errors,
	requests: 40,
	topRoute: "GET /checkout",
	activity: [1, 2, 3, 4, 5, 6, 7],
	signals: ["replay", "traces"],
})

const profile: UserProfileItem = {
	userId: "u_ada",
	name: "Ada Lovelace",
	email: "ada@acme.com",
	groupId: "acme",
	groupName: "Acme Inc.",
	traits: [{ key: "plan", value: "pro" }],
	visitorIds: ["v_1"],
	firstSeenMs: AT - 3_600_000,
	lastSeenMs: AT,
	sessions: 2,
	recordedMs: 60_000,
	replayErrors: 1,
	events: 4,
	distinctEvents: 2,
	mcpRequests: 3,
	mcpCalls: 2,
	devices: [{ browser: "Chrome", os: "macOS", sessions: 2 }],
	country: "GB",
	services: [{ service: "storefront-web", namespace: "storefront", signals: 12 }],
	signals: ["replay", "mcp", "traces"],
	requests: 40,
	failedRate: 0.05,
	p95Ms: 820,
	traces: 38,
	logs: 9,
	issues: 1,
	issueHits: 3,
	topRoute: "GET /checkout",
	activity: [1, 2, 3, 4, 5, 6, 7],
}

type Seen = { list?: UsersListRequest; detail?: UserDetailRequest; calls?: Array<string> }

const reads = (
	seen: Seen,
	opts: { readonly users?: ReadonlyArray<UserListItem>; readonly known?: boolean } = {},
) => {
	const profileRead = (request: UserDetailRequest) => {
		seen.detail = request
		return new UserProfileResponse({ profile: opts.known === false ? null : profile })
	}
	const activityRead = () =>
		new UserActivityResponse({
			sessions: [
				{
					sessionId: "sess_1",
					service: "storefront-web",
					startedMs: AT - 600_000,
					durationMs: 120_000,
					pages: 4,
					errors: 1,
					entryPath: "/checkout",
					device: "Chrome · macOS",
				},
			],
			events: [],
			mcpSessions: [
				{
					service: "maple-mcp",
					sessionId: "mcp_sess_9",
					source: "issued",
					client: "claude-code",
					kind: "agent",
					requests: 3,
					calls: 2,
					errors: 0,
					tools: 2,
					firstSeenMs: AT - 300_000,
					lastSeenMs: AT - 200_000,
				},
			],
			activity: [
				{
					kind: "request",
					atMs: AT,
					service: "storefront-api",
					title: "POST /orders",
					detail: "Failed · 912 ms · storefront-api",
					tone: "crit",
					sessionId: null,
					traceId: TRACE_ID,
					issueId: null,
				},
				{
					kind: "request",
					atMs: AT - 1000,
					service: "storefront-api",
					title: "GET /slow",
					detail: "Slow · 2400 ms · storefront-api",
					tone: "warn",
					sessionId: null,
					traceId: "slowtrace",
					issueId: null,
				},
			],
		})
	const issuesRead = () =>
		new UserIssuesResponse({
			issues: [
				{
					issueId: ISSUE_ID,
					fingerprintHash: "11640295108927840024",
					type: "TypeError",
					message: "cart is undefined",
					service: "storefront-web",
					hits: 3,
					firstSeenMs: AT - 3_000_000,
					lastSeenMs: AT,
					status: "triage",
				},
			],
			attributed: true,
		})
	const called = (name: string) => (seen.calls ??= []).push(name)
	return Layer.mock(UsersReadService)({
		list: (_tenant, request) => {
			seen.list = request
			// Like the read: the users after the keyset, at most `limit`, and `next` only when more match.
			const after = request.after
			const from =
				after === undefined
					? []
					: Arr.dropWhile(opts.users ?? [], (user) => user.userId !== after.userId)
			const all = after === undefined ? (opts.users ?? []) : Arr.drop(from, 1)
			const limit = request.limit ?? all.length
			const page = Arr.take(all, limit)
			const last = page.at(-1)
			return Effect.succeed(
				new UsersListResponse({
					users: page,
					...(all.length > limit &&
						last !== undefined && {
							next: { lastSeen: "2026-11-01 00:00:00.000000000", userId: last.userId },
						}),
				}),
			)
		},
		profile: (_tenant, request) => Effect.sync(() => (called("profile"), profileRead(request))),
		activity: () => Effect.sync(() => (called("activity"), activityRead())),
		issues: () => Effect.sync(() => (called("issues"), issuesRead())),
		overview: (_tenant, request) =>
			Effect.sync(() => {
				called("overview")
				return new UserOverviewResponse({
					profile: profileRead(request).profile,
					activity: activityRead(),
					issues: issuesRead(),
				})
			}),
	})
}

/** `scopes` set is a scoped API key; unset is an unscoped key, OAuth token or session. */
const tenantWith = (scopes?: ReadonlyArray<string>) =>
	Layer.succeed(CurrentMcpTenant, {
		orgId: Schema.decodeSync(OrgId)("org_user_tools"),
		userId: Schema.decodeSync(UserId)("user_user_tools"),
		roles: [Schema.decodeSync(RoleName)("org:member")],
		authMode: "self_hosted",
		...(scopes === undefined ? undefined : { scopes }),
	})

// The registry's requirements name every tool's services; these tools reach only the users reads.
const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

const run = (
	name: string,
	params: unknown,
	layer: Layer.Layer<UsersReadService>,
	scopes?: ReadonlyArray<string>,
) =>
	Effect.runPromise(
		executeRegisteredMcpToolUnscoped(name, params, "mcp").pipe(
			Effect.provide(Layer.merge(layer, tenantWith(scopes))),
			Effect.result,
			withoutUnreachedServices,
		),
	)

const ok = async (name: string, params: unknown, layer: Layer.Layer<UsersReadService>) => {
	const result = await run(name, params, layer)
	if (result._tag !== "Success") throw new Error(`${name} failed: ${JSON.stringify(result.failure)}`)
	return result.success
}

const text = (result: McpToolResult) => result.content[0]?.text ?? ""

describe("list_users", () => {
	it("passes the filters to the read, pages by lookahead and points at the user with errors", async () => {
		const seen: Seen = {}
		const users = [listUser("u_quiet", 0), listUser("u_ada", 2), listUser("u_extra", 0)]
		const result = await ok(
			"list_users",
			{ ...WINDOW, namespaces: "storefront, billing", search: "ada", has_errors: true, limit: 2 },
			reads(seen, { users }),
		)
		expect(seen.list?.limit).toBe(2)
		expect(seen.list?.namespaces).toEqual(["storefront", "billing"])
		expect(seen.list?.search).toBe("ada")
		expect(seen.list?.hasErrors).toBe(true)

		const output = Schema.decodeUnknownSync(ListUsersOutput)(result.structuredContent)
		expect(Arr.map(output.users, (user) => user.userId)).toEqual(["u_quiet", "u_ada"])
		expect(output.limit).toBe(2)
		expect(output.nextCursor).toBeDefined()

		const markdown = text(result)
		expect(markdown).toContain("Ada Lovelace")
		expect(markdown).toContain("Acme Inc. (acme)")
		expect(markdown).toContain('list_users start_time="2026-11-01 00:00:00"')
		expect(markdown).toContain(`cursor="${output.nextCursor}"`)

		// The cursor continues after the page's last user, whatever reordered in between.
		const next = await ok(
			"list_users",
			{ ...WINDOW, limit: 2, cursor: output.nextCursor },
			reads(seen, { users }),
		)
		expect(seen.list?.after).toEqual({ lastSeen: "2026-11-01 00:00:00.000000000", userId: "u_ada" })
		const second = Schema.decodeUnknownSync(ListUsersOutput)(next.structuredContent)
		expect(Arr.map(second.users, (user) => user.userId)).toEqual(["u_extra"])
		expect(second.nextCursor).toBeUndefined()
		expect(markdown).toMatch(/inspect_user user_id="u_ada".*what went wrong for Ada Lovelace/)
	})

	it("refuses a cursor it did not hand out", async () => {
		const result = await run("list_users", { ...WINDOW, cursor: "not-a-cursor" }, reads({}))
		expect(result._tag).toBe("Failure")
	})

	it("leaves has_errors=false out of the read, since only true filters", async () => {
		const seen: Seen = {}
		await ok("list_users", { ...WINDOW, has_errors: false }, reads(seen))
		expect(seen.list?.hasErrors).toBeUndefined()
	})

	it("refuses more namespaces than the read accepts", async () => {
		const result = await run(
			"list_users",
			{ ...WINDOW, namespaces: Arr.makeBy(51, (index) => `ns${index}`) },
			reads({}),
		)
		expect(result._tag).toBe("Failure")
		expect(result._tag === "Failure" ? result.failure._tag : undefined).toBe(
			"@maple/mcp/errors/McpInvalidInputError",
		)
	})
})

describe("inspect_user", () => {
	it("shows sessions, MCP sessions, issues and failed requests with calls to open each", async () => {
		const seen: Seen = {}
		const result = await ok("inspect_user", { ...WINDOW, user_id: "u_ada" }, reads(seen))
		expect(seen.detail?.userId).toBe("u_ada")
		// One overview read: the scope and the issues are not read again per section.
		expect(seen.calls).toEqual(["overview"])

		const output = Schema.decodeUnknownSync(InspectUserOutput)(result.structuredContent)
		expect(output.profile?.email).toBe("ada@acme.com")
		expect(Arr.map(output.failedRequests, (request) => request.traceId)).toEqual([TRACE_ID])
		expect(output.issuesAttributed).toBe(true)

		const markdown = text(result)
		expect(markdown).toContain("| maple-mcp | mcp_sess_9 | claude-code | agent |")
		expect(markdown).toContain("plan=pro")
		expect(markdown).toContain("Acme Inc. (acme)")
		expect(markdown).toContain(`inspect_trace trace_id="${TRACE_ID}" timestamp="2026-11-01 12:30:00"`)
		expect(markdown).toContain(`error_detail issue_id="${ISSUE_ID}"`)
		expect(markdown).toContain('get_session_transcript session_id="sess_1"')
		expect(markdown).toContain('search_sessions start_time="2026-11-01 00:00:00"')
		expect(markdown).not.toContain("slowtrace")
	})

	it("says nothing carries an unknown user and suggests finding the exact id", async () => {
		const result = await ok(
			"inspect_user",
			{ ...WINDOW, user_id: "u_nobody" },
			reads({}, { known: false }),
		)
		const markdown = text(result)
		expect(markdown).toContain("No signal in the window carries user u_nobody")
		expect(markdown).toContain(
			'list_users start_time="2026-11-01 00:00:00" end_time="2026-11-02 00:00:00" search="u_nobody"',
		)
	})
})

describe("user tools under a scoped API key", () => {
	const calls = [
		["list_users", WINDOW],
		["inspect_user", { ...WINDOW, user_id: "u_ada" }],
	] as const

	it("refuses a key without users:read, as GET /v2/users does, without reading", async () => {
		const results = await Promise.all(
			Arr.map(calls, async ([name, params]) => {
				const seen: Seen = {}
				const result = await run(name, params, reads(seen), ["traces:read", "error_issues:read"])
				return { name, result, seen }
			}),
		)
		Arr.forEach(results, ({ name, result, seen }) => {
			expect(result._tag).toBe("Failure")
			if (result._tag === "Failure") {
				expect(result.failure).toMatchObject({
					_tag: "@maple/mcp/errors/McpAuthInvalidError",
					reason: "insufficient_scope",
				})
				expect(result.failure.message).toContain("users:read")
				expect(result.failure.message).toContain(name)
			}
			expect(seen).toEqual({})
		})
	})

	it("runs both tools for a key holding users:read or users:write", async () => {
		const results = await Promise.all(
			Arr.flatMap([["traces:read", "users:read"], ["users:write"], ["*"]], (scopes) =>
				Arr.map(calls, ([name, params]) => run(name, params, reads({}), scopes)),
			),
		)
		expect(Arr.map(results, (result) => result._tag)).toEqual(Arr.map(results, () => "Success"))
	})
})

describe("inspect_user failed requests", () => {
	it("says a capped timeline hid the failures instead of claiming there were none", () => {
		expect(noFailedRequestsText({ requests: 400, failedRate: 0.05 })).toBe(
			"20 failed requests in the window, none among the timeline's most recent rows.",
		)
		expect(noFailedRequestsText({ requests: 400, failedRate: 0 })).toBe(
			"No failed requests in the window.",
		)
		expect(noFailedRequestsText({ requests: 200, failedRate: 0.005 })).toBe(
			"1 failed request in the window, none among the timeline's most recent rows.",
		)
		expect(noFailedRequestsText(null)).toBe("No failed requests among the timeline's most recent rows.")
	})
})
