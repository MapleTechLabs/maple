import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Schema, String as Str } from "effect"
import { OrgId, UserId, UsersFacetsRequest, WarehouseConfigError } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { readUsersFacets } from "./users-reads"

// The directory's rail and summary: the namespace facet unpinned, none under a pin, and no re-read
// without the rollup when a missing rollup leaves no other source that could hold a user.

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_users_facets"),
	userId: Schema.decodeSync(UserId)("user_member"),
	roles: ["org:admin"],
	authMode: "self_hosted",
}

type Ran = Array<Readonly<{ context: string; sql: string }>>

const rows = new Map<string, ReadonlyArray<unknown>>([
	["usersServiceNamespaces", [{ service: "web", namespace: "storefront", spans: "5" }]],
	["mcpServices", []],
	[
		"usersFacets",
		[
			{ facetType: "namespace", name: "storefront", count: "4" },
			{ facetType: "group", name: "grp_acme", count: "2" },
		],
	],
	["usersGroupNames", [{ groupId: "grp_acme", groupName: "Acme Inc." }]],
	["usersSummary", [{ identified: "4", activeToday: "3", withErrors: "1", withReplay: "2" }]],
	["usersAnonymousVisitors", [{ anonymousVisitors: "9" }]],
])

const warehouse = (ran: Ran) =>
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

const request = (namespaces?: ReadonlyArray<string>) =>
	new UsersFacetsRequest({
		startTime: "2026-11-01 00:00:00",
		endTime: "2026-11-02 00:00:00",
		...(namespaces !== undefined && { namespaces }),
	})

const facetsSql = (ran: Ran) =>
	Arr.join(
		Arr.map(
			Arr.filter(ran, (query) => query.context === "usersFacets"),
			(query) => query.sql,
		),
		"\n",
	)

describe("readUsersFacets", () => {
	it.effect("counts every namespace and folds each facet and the summary when nothing is pinned", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const facets = yield* readUsersFacets(tenant, request()).pipe(Effect.provide(warehouse(ran)))
			assert.deepStrictEqual(facets.namespaces, [{ name: "storefront", count: 4 }])
			assert.deepStrictEqual(facets.groups, [{ name: "grp_acme", label: "Acme Inc.", count: 2 }])
			assert.deepStrictEqual(
				[
					facets.identified,
					facets.activeToday,
					facets.withErrors,
					facets.withReplay,
					facets.anonymousVisitors,
				],
				[4, 3, 1, 2, 9],
			)
			assert.isTrue(Str.includes("'namespace' AS facetType")(facetsSql(ran)))
		}),
	)

	it.effect("leaves the namespace facet out of the read under a pin", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			yield* readUsersFacets(tenant, request(["storefront"])).pipe(Effect.provide(warehouse(ran)))
			assert.isFalse(Str.includes("'namespace' AS facetType")(facetsSql(ran)))
		}),
	)

	it.effect("reads a pin no raw source covers through the rollup, which carries the namespace", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			yield* readUsersFacets(tenant, request(["ghost"])).pipe(Effect.provide(warehouse(ran)))
			assert.isTrue(Arr.some(ran, (query) => query.context === "usersFacets"))
		}),
	)

	it.effect("reads no more once the rollup is missing and the pin leaves no other source", () =>
		Effect.gen(function* () {
			const ran: Ran = []
			const noRollup = Layer.succeed(
				WarehouseQueryService,
				makeWarehouseServiceStub({
					compiledQuery: (_tenant, input, options) => {
						const compiled = compiledQueryOf(input)
						const context = options?.context ?? ""
						ran.push({ context, sql: compiled.sql })
						return Str.includes("user_activity_hourly")(compiled.sql)
							? Effect.fail(
									new WarehouseConfigError({
										message:
											"Code: 60. Table default.user_activity_hourly does not exist",
										pipeName: context,
										clickhouseType: "UNKNOWN_TABLE",
									}),
								)
							: compiled.decodeRows(rows.get(context) ?? []).pipe(Effect.orDie)
					},
				}),
			)
			const facets = yield* readUsersFacets(tenant, request(["ghost"])).pipe(Effect.provide(noRollup))
			assert.strictEqual(facets.identified, 0)
			assert.deepStrictEqual(facets.namespaces, [])
			// The rollup read failed once; nothing was re-read without it.
			assert.isTrue(
				Arr.every(
					Arr.filter(ran, (query) => query.context === "usersFacets"),
					(query) => Str.includes("user_activity_hourly")(query.sql),
				),
			)
		}),
	)
})
