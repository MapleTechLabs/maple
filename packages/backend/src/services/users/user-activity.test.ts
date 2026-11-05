import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Schema, String as Str } from "effect"
import { OrgId, UserDetailRequest, UserId } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { readUserActivity } from "./users-reads"

const ORG = Schema.decodeSync(OrgId)("org_user_activity")
const USER = Schema.decodeSync(UserId)("user_member")
const tenant: TenantContext = { orgId: ORG, userId: USER, roles: ["org:admin"], authMode: "self_hosted" }

const minuteRow = (minute: string, calls: number, errors: number, tools: ReadonlyArray<string>) => ({
	user: "user_42",
	client: "Claude Code",
	minute,
	kind: "agent",
	userName: "Ada",
	requests: calls,
	calls,
	errors,
	tools,
	firstSeen: `${minute}.000`,
	lastSeen: `${minute}.000`,
})

/** Query context to wire rows; MCP reads answer per server, keyed on the service they were asked for. */
const fixture = new Map<string, ReadonlyArray<unknown>>([
	[
		"usersServiceNamespaces",
		[
			{ service: "docs-mcp", namespace: "platform", spans: "10" },
			{ service: "web", namespace: "storefront", spans: "5" },
		],
	],
	[
		"mcpServices",
		[
			{ service: "docs-mcp", serverSpans: "4" },
			{ service: "maple-ai", serverSpans: "9" },
		],
	],
	[
		"userMcpSessionList:maple-ai",
		[
			{
				sessionId: "sess-1",
				client: "Cursor",
				kind: "agent",
				user: "user_42",
				userName: "",
				requests: "6",
				calls: "3",
				errors: "1",
				tools: "2",
				firstSeen: "2026-11-01 10:00:00.000",
				lastSeen: "2026-11-01 10:05:00.000",
			},
		],
	],
	// Two bursts 40 minutes apart: the 30 minute idle gap splits them into two sessions.
	[
		"userMcpActivity:docs-mcp",
		[
			minuteRow("2026-11-01 09:40:00", 1, 0, ["search"]),
			minuteRow("2026-11-01 09:00:00", 2, 0, ["search", "fetch"]),
			minuteRow("2026-11-01 09:01:00", 1, 1, ["fetch"]),
		],
	],
])

const run = (payload: UserDetailRequest, seen: Array<string>) =>
	readUserActivity(tenant, payload).pipe(
		Effect.provide(
			Layer.succeed(
				WarehouseQueryService,
				makeWarehouseServiceStub({
					compiledQuery: (_tenant, input, options) => {
						const compiled = compiledQueryOf(input)
						const context = options?.context ?? ""
						seen.push(context)
						const service = /ServiceName = '([^']+)'/.exec(compiled.sql)?.[1] ?? ""
						const rows = fixture.get(`${context}:${service}`) ?? fixture.get(context) ?? []
						return compiled.decodeRows(rows).pipe(Effect.orDie)
					},
				}),
			),
		),
	)

const request = (namespaces?: ReadonlyArray<string>) =>
	new UserDetailRequest({
		startTime: "2026-11-01 00:00:00",
		endTime: "2026-11-02 00:00:00",
		userId: "user_42",
		...(namespaces !== undefined && { namespaces }),
	})

describe("readUserActivity", () => {
	it.effect("lists the user's MCP sessions across every server, issued and split at idle gaps", () =>
		Effect.gen(function* () {
			const response = yield* run(request(), [])
			assert.deepStrictEqual(
				Arr.map(response.mcpSessions, (session) => [session.service, session.source, session.calls]),
				[
					["maple-ai", "issued", 3],
					["docs-mcp", "user", 1],
					["docs-mcp", "user", 3],
				],
			)
			const [, later, earlier] = response.mcpSessions
			assert.isTrue(Str.startsWith("user:")(later?.sessionId ?? ""))
			assert.strictEqual(earlier?.tools, 2)
			assert.strictEqual(earlier?.errors, 1)
		}),
	)

	it.effect("puts each MCP session on the Activity timeline with its server", () =>
		Effect.gen(function* () {
			const response = yield* run(request(), [])
			assert.deepStrictEqual(
				Arr.map(response.activity, (item) => [item.kind, item.service, item.tone]),
				[
					["mcp", "maple-ai", "crit"],
					["mcp", "docs-mcp", "neutral"],
					["mcp", "docs-mcp", "crit"],
				],
			)
			assert.strictEqual(response.activity[0]?.sessionId, "sess-1")
		}),
	)

	it.effect("reads only the MCP servers under the picked namespace", () =>
		Effect.gen(function* () {
			const seen: Array<string> = []
			const response = yield* run(request(["platform"]), seen)
			assert.deepStrictEqual(
				[...new Set(Arr.map(response.mcpSessions, (session) => session.service))],
				["docs-mcp"],
			)
			assert.strictEqual(Arr.filter(seen, (context) => context === "userMcpSessionList").length, 1)
		}),
	)
})
