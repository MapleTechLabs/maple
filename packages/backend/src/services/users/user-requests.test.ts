import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { OrgId, UserDetailRequest, UserId, UsersListRequest, WarehouseConfigError } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { readUserActivity, readUserLogs, readUserProfile, readUserTraces, readUsersList } from "./users-reads"

// The users pages' span and log reads: rollup slices first, a raw read only where they point, and
// a cluster without `user_activity_hourly` (migration 0056) answering empty instead of failing.

const ORG = Schema.decodeSync(OrgId)("org_user_requests")
const USER = Schema.decodeSync(UserId)("user_member")
const tenant: TenantContext = { orgId: ORG, userId: USER, roles: ["org:admin"], authMode: "self_hosted" }

type Fixture = ReadonlyMap<string, ReadonlyArray<unknown>>
type Ran = Array<Readonly<{ context: string; sql: string }>>

const missingRollup = new WarehouseConfigError({
	message: "Code: 60. Table default.user_activity_hourly does not exist",
	pipeName: "usersList",
	clickhouseType: "UNKNOWN_TABLE",
})

/** A warehouse answering by query context; without the rollup, any SQL naming it fails like BYO. */
const warehouse = (fixture: Fixture, ran: Ran, hasRollup = true) =>
	Layer.succeed(
		WarehouseQueryService,
		makeWarehouseServiceStub({
			compiledQuery: (_tenant, input, options) => {
				const compiled = compiledQueryOf(input)
				const context = options?.context ?? ""
				ran.push({ context, sql: compiled.sql })
				if (!hasRollup && compiled.sql.includes("user_activity_hourly"))
					return Effect.fail(missingRollup)
				return compiled.decodeRows(fixture.get(context) ?? []).pipe(Effect.orDie)
			},
		}),
	)

const request = new UserDetailRequest({
	startTime: "2026-11-01 00:00:00",
	endTime: "2026-11-02 00:00:00",
	userId: "user_42",
	namespaces: ["storefront"],
})

const slice = (hour: string, serviceName: string, requestCount: number, logCount: number) => ({
	hour,
	serviceName,
	serviceNamespace: "storefront",
	spanCount: String(requestCount * 3),
	requestCount: String(requestCount),
	logCount: String(logCount),
})

const fixture: Fixture = new Map<string, ReadonlyArray<unknown>>([
	[
		"userActivitySlices",
		[slice("2026-11-01 14:00:00", "checkout", 4, 0), slice("2026-11-01 09:00:00", "worker", 0, 7)],
	],
	[
		"userTraces",
		[
			{
				traceId: "a1b2",
				spanId: "s1",
				timestamp: "2026-11-01 14:12:00.000000000",
				serviceName: "checkout",
				spanName: "POST /checkout",
				spanKind: "Server",
				durationMs: "812.5",
				statusCode: "Error",
				isRoot: "1",
			},
		],
	],
	[
		"userLogs",
		[
			{
				timestamp: "2026-11-01 09:30:00.000000000",
				serviceName: "worker",
				severityText: "",
				severityNumber: "17",
				body: "charge failed",
				traceId: "",
				spanId: "",
			},
		],
	],
])

describe("readUserTraces", () => {
	it.effect("reads raw spans only from the services and hours the rollup saw requests in", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const response = yield* readUserTraces(tenant, request).pipe(
				Effect.provide(warehouse(fixture, ran)),
			)
			assert.deepStrictEqual(
				ran.map((query) => query.context),
				["userActivitySlices", "userTraces"],
			)
			const raw = ran[1]?.sql ?? ""
			assert.include(raw, "traces.ServiceName IN ('checkout')")
			assert.include(raw, "traces.Timestamp >= '2026-11-01 14:00:00'")
			assert.include(raw, "traces.Timestamp <= '2026-11-01 14:59:59'")
			assert.deepStrictEqual(
				response.traces.map((trace) => [
					trace.traceId,
					trace.spanName,
					trace.status,
					trace.durationMs,
				]),
				[["a1b2", "POST /checkout", "Error", 812.5]],
			)
		}),
	)

	it.effect("never scans raw spans when the rollup holds no request from the user", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const empty = new Map([["userActivitySlices", [slice("2026-11-01 09:00:00", "worker", 0, 7)]]])
			const response = yield* readUserTraces(tenant, request).pipe(
				Effect.provide(warehouse(empty, ran)),
			)
			assert.deepStrictEqual(
				ran.map((query) => query.context),
				["userActivitySlices"],
			)
			assert.deepStrictEqual(response.traces, [])
		}),
	)

	it.effect("answers empty on a cluster without the rollup, with no raw scan", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const response = yield* readUserTraces(tenant, request).pipe(
				Effect.provide(warehouse(fixture, ran, false)),
			)
			assert.deepStrictEqual(response.traces, [])
			assert.isFalse(ran.some((query) => query.context === "userTraces"))
		}),
	)
})

describe("readUserLogs", () => {
	it.effect("reads raw logs only where the rollup saw log lines, naming the level of a bare number", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const response = yield* readUserLogs(tenant, request).pipe(
				Effect.provide(warehouse(fixture, ran)),
			)
			assert.include(ran[1]?.sql ?? "", "logs.ServiceName IN ('worker')")
			assert.deepStrictEqual(
				response.logs.map((log) => [log.severity, log.service, log.body]),
				[["ERROR", "worker", "charge failed"]],
			)
		}),
	)
})

const scopeRows: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]> = [
	["usersServiceNamespaces", [{ service: "web", namespace: "storefront", spans: "5" }]],
	["mcpServices", []],
]

describe("a cluster without user_activity_hourly", () => {
	it.effect("lists users from the other sources instead of failing the directory", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const rows = new Map<string, ReadonlyArray<unknown>>([
				...scopeRows,
				[
					"usersList",
					[
						{
							userId: "user_42",
							name: "Ada",
							email: "",
							groupId: "",
							namespaces: ["storefront"],
							firstSeen: "2026-11-01 08:00:00.000000000",
							lastSeen: "2026-11-01 09:00:00.000000000",
							lastSeenKey: "2026-11-01 09:00:00.000000000",
							sessions: "2",
							errors: "1",
							requests: "0",
							mcpSpans: "0",
							events: "3",
							spans: "0",
							logLines: "0",
						},
					],
				],
			])
			const response = yield* readUsersList(
				tenant,
				new UsersListRequest({ startTime: request.startTime, endTime: request.endTime }),
			).pipe(Effect.provide(warehouse(rows, ran, false)))
			const lists = ran.filter((query) => query.context === "usersList")
			assert.strictEqual(lists.length, 2)
			assert.include(lists[0]?.sql ?? "", "FROM user_activity_hourly")
			assert.notInclude(lists[1]?.sql ?? "", "user_activity_hourly")
			assert.deepStrictEqual(
				response.users.map((user) => [user.userId, user.topRoute, user.activity]),
				[["user_42", null, []]],
			)
		}),
	)

	it.effect("leaves the profile's request figures unknown rather than zero", () =>
		Effect.gen(function* () {
			const rows = new Map<string, ReadonlyArray<unknown>>([
				...scopeRows,
				[
					"userEventsSummary",
					[
						{
							events: "3",
							distinctEvents: "2",
							firstSeen: "2026-11-01 08:00:00.000000000",
							lastSeen: "2026-11-01 09:00:00.000000000",
						},
					],
				],
			])
			const response = yield* readUserProfile(tenant, request).pipe(
				Effect.provide(warehouse(rows, [], false)),
			)
			assert.strictEqual(response.profile?.events, 3)
			assert.isNull(response.profile?.requests)
			assert.isNull(response.profile?.p95Ms)
			assert.isNull(response.profile?.traces)
			assert.deepStrictEqual(response.profile?.activity, [])
		}),
	)

	it.effect("keeps the activity timeline without its notable requests", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const response = yield* readUserActivity(tenant, request).pipe(
				Effect.provide(warehouse(new Map(scopeRows), ran, false)),
			)
			assert.deepStrictEqual(response.activity, [])
			assert.isFalse(ran.some((query) => query.context.startsWith("userNotable")))
		}),
	)
})

describe("readUserActivity", () => {
	it.effect("puts the user's failed requests and error logs on the timeline", () =>
		Effect.gen(function* () {
			const notable = new Map<string, ReadonlyArray<unknown>>([
				...scopeRows,
				["userActivitySlices", fixture.get("userActivitySlices") ?? []],
				["userNotableTraces", fixture.get("userTraces") ?? []],
				["userNotableLogs", fixture.get("userLogs") ?? []],
			])
			const ran: Ran = []
			const response = yield* readUserActivity(tenant, request).pipe(
				Effect.provide(warehouse(notable, ran)),
			)
			assert.deepStrictEqual(
				response.activity.map((item) => [item.kind, item.tone, item.traceId]),
				[
					["request", "crit", "a1b2"],
					["log", "crit", null],
				],
			)
			assert.include(
				ran.find((query) => query.context === "userNotableTraces")?.sql ?? "",
				"(traces.StatusCode = 'Error' OR traces.Duration >= 2000000000)",
			)
		}),
	)
})

const listRow = (userId: string, name: string) => ({
	userId,
	name,
	email: "",
	groupId: "",
	namespaces: [],
	firstSeen: "2026-11-01 08:00:00.000000000",
	lastSeen: "2026-11-01 09:00:00.000000000",
	sessions: "0",
	errors: "0",
	requests: "3",
	mcpSpans: "3",
	events: "0",
	spans: "3",
	logLines: "0",
})

describe("the directory's MCP-only users", () => {
	it.effect("take the name their MCP spans carry, read for the unnamed rows only", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const rows = new Map<string, ReadonlyArray<unknown>>([
				["usersServiceNamespaces", []],
				["mcpServices", [{ service: "docs-mcp", serverSpans: "4" }]],
				["usersList", [listRow("user_42", ""), listRow("user_7", "Grace")]],
				["usersMcpNames", [{ userId: "user_42", name: "Ada", email: "ada@example.com" }]],
			])
			const response = yield* readUsersList(
				tenant,
				new UsersListRequest({ startTime: request.startTime, endTime: request.endTime }),
			).pipe(Effect.provide(warehouse(rows, ran)))
			assert.deepStrictEqual(
				response.users.map((user) => [user.userId, user.name, user.email]),
				[
					["user_42", "Ada", "ada@example.com"],
					["user_7", "Grace", null],
				],
			)
			const names = ran.find((query) => query.context === "usersMcpNames")?.sql ?? ""
			assert.include(names, "traces.ServiceName IN ('docs-mcp')")
			assert.include(names, "IN ('user_42')")
			assert.notInclude(names, "user_7")
		}),
	)
})

describe("searching the directory on the rollup", () => {
	it.effect("finds an MCP-only user by the name its spans carry", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const rows = new Map<string, ReadonlyArray<unknown>>([
				["usersServiceNamespaces", []],
				["mcpServices", [{ service: "docs-mcp", serverSpans: "4" }]],
				["usersMcpNameSearch", [{ userId: "user_42" }]],
				["usersList", [listRow("user_42", "")]],
				["usersMcpNames", [{ userId: "user_42", name: "Ada Lovelace", email: "" }]],
			])
			const response = yield* readUsersList(
				tenant,
				new UsersListRequest({
					startTime: request.startTime,
					endTime: request.endTime,
					search: "lovelace",
				}),
			).pipe(Effect.provide(warehouse(rows, ran)))
			assert.deepStrictEqual(
				response.users.map((user) => [user.userId, user.name]),
				[["user_42", "Ada Lovelace"]],
			)
			const searches = ran.filter((query) => query.context === "usersMcpNameSearch")
			assert.strictEqual(searches.length, 1)
			assert.include(searches[0]?.sql ?? "", "traces.ServiceName IN ('docs-mcp')")
			assert.include(
				ran.find((query) => query.context === "usersList")?.sql ?? "",
				"signals.userId IN ('user_42')",
			)
		}),
	)

	it.effect("runs no name search without a search term", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const rows = new Map<string, ReadonlyArray<unknown>>([
				["usersServiceNamespaces", []],
				["mcpServices", [{ service: "docs-mcp", serverSpans: "4" }]],
				["usersList", [listRow("user_7", "Grace")]],
			])
			yield* readUsersList(
				tenant,
				new UsersListRequest({ startTime: request.startTime, endTime: request.endTime }),
			).pipe(Effect.provide(warehouse(rows, ran)))
			assert.strictEqual(ran.filter((query) => query.context === "usersList").length, 1)
			assert.isFalse(ran.some((query) => query.context === "usersMcpNameSearch"))
		}),
	)
})

describe("readUserProfile", () => {
	it.effect("takes the top route and the request spark from the one summary read", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const rows = new Map<string, ReadonlyArray<unknown>>([
				...scopeRows,
				[
					"userActivitySummary",
					[
						{
							spanCount: "9",
							errorSpanCount: "0",
							requestCount: "4",
							failedRequestCount: "1",
							traceCount: "4",
							sessionCount: "0",
							p50DurationMs: "20",
							p95DurationMs: "80",
							logCount: "0",
							warnLogCount: "0",
							errorLogCount: "0",
							topRoutes: ["POST /checkout"],
							topRouteCounts: ["4"],
							requestHours: [String(Date.UTC(2026, 10, 1, 14) / 1000)],
							requestHourCounts: ["4"],
							firstSeen: "2026-11-01 14:00:00",
							lastSeen: "2026-11-01 14:30:00",
						},
					],
				],
			])
			const response = yield* readUserProfile(tenant, request).pipe(
				Effect.provide(warehouse(rows, ran)),
			)
			assert.strictEqual(response.profile?.topRoute, "POST /checkout")
			assert.deepStrictEqual(response.profile?.activity, [0, 0, 0, 0, 4, 0, 0])
			assert.isFalse(ran.some((query) => query.context === "userActivityTotals"))
		}),
	)
})
