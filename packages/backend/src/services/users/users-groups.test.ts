import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Schema, String as Str } from "effect"
import { OrgId, UserId, UsersGroupsRequest } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { readUsersGroups } from "./users-reads"

// The directory's group view: the warehouse's group rows named and ordered for the page. What the
// SQL counts is proven against ClickHouse in `users-groups.clickhouse.e2e.test.ts`.

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_users_groups"),
	userId: Schema.decodeSync(UserId)("user_member"),
	roles: ["org:admin"],
	authMode: "self_hosted",
}

type Ran = Array<Readonly<{ context: string; sql: string }>>

const groupRow = (groupId: string, users: number) => ({
	groupId,
	users: String(users),
	activeToday: "1",
	withErrors: "0",
	withReplay: "1",
	sessions: "2",
	errors: "0",
	requests: "3",
	firstSeen: "2026-11-01 08:00:00.000000000",
	lastSeen: "2026-11-01 09:00:00.000000000",
})

const warehouse = (rows: ReadonlyMap<string, ReadonlyArray<unknown>>, ran: Ran) =>
	Layer.succeed(
		WarehouseQueryService,
		makeWarehouseServiceStub({
			compiledQuery: (_tenant, input, options) => {
				const compiled = compiledQueryOf(input)
				const context = options?.context ?? ""
				ran.push({ context, sql: compiled.sql })
				return compiled.decodeRows(rows.get(context) ?? []).pipe(Effect.orDie)
			},
		}),
	)

const request = (fields: Partial<UsersGroupsRequest> = {}) =>
	new UsersGroupsRequest({ startTime: "2026-11-01 00:00:00", endTime: "2026-11-02 00:00:00", ...fields })

const sqlOf = (ran: Ran, context: string) =>
	Arr.join(
		Arr.map(
			Arr.filter(ran, (query) => query.context === context),
			(query) => query.sql,
		),
		"\n",
	)

describe("readUsersGroups", () => {
	it.effect("names the groups and puts the ungrouped users last", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const rows = new Map<string, ReadonlyArray<unknown>>([
				["usersServiceNamespaces", []],
				["mcpServices", []],
				["usersGroups", [groupRow("", 9), groupRow("grp_acme", 4), groupRow("grp_hooli", 1)]],
				["usersGroupNames", [{ groupId: "grp_acme", groupName: "Acme Inc." }]],
			])
			const response = yield* readUsersGroups(tenant, request()).pipe(
				Effect.provide(warehouse(rows, ran)),
			)
			assert.deepStrictEqual(
				Arr.map(response.groups, (group) => [group.groupId, group.groupName, group.users]),
				[
					["grp_acme", "Acme Inc.", 4],
					["grp_hooli", null, 1],
					[null, null, 9],
				],
			)
			assert.isFalse(response.truncated)
			assert.isTrue(Str.includes("IN ('grp_acme', 'grp_hooli')")(sqlOf(ran, "usersGroupNames")))
		}),
	)

	it.effect("narrows the groups with the directory's filters", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const rows = new Map<string, ReadonlyArray<unknown>>([
				["usersServiceNamespaces", []],
				["mcpServices", []],
			])
			yield* readUsersGroups(tenant, request({ hasErrors: true, groups: ["grp_acme"] })).pipe(
				Effect.provide(warehouse(rows, ran)),
			)
			const sql = sqlOf(ran, "usersGroups")
			assert.isTrue(Str.includes("arrayIntersect")(sql))
			assert.isTrue(Str.includes("sum(signals.errors) > 0")(sql))
		}),
	)

	it.effect("says when more groups exist than it lists", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const rows = new Map<string, ReadonlyArray<unknown>>([
				["usersServiceNamespaces", []],
				["mcpServices", []],
				["usersGroups", Arr.makeBy(201, (i) => groupRow(`grp_${i}`, 1))],
			])
			const response = yield* readUsersGroups(tenant, request()).pipe(
				Effect.provide(warehouse(rows, ran)),
			)
			assert.strictEqual(response.groups.length, 200)
			assert.isTrue(response.truncated)
		}),
	)
})
