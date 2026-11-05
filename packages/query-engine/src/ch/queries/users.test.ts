import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, String as Str } from "effect"
import { compileUnionUnsafe, compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	hasUserSources,
	userDevicesQuery,
	userEventsQuery,
	userEventsSummaryQuery,
	userMcpSummaryQuery,
	userReplayProfileQuery,
	userServicesQuery,
	userVisitorIdsQuery,
	usersAnonymousVisitorsQuery,
	usersFacetsQuery,
	usersListQuery,
	usersSummaryQuery,
	type UsersScope,
} from "./users"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-06-24 04:00:00",
	endTime: "2026-06-25 06:00:00",
	activeSince: "2026-06-24 06:00:00",
}

const unscoped: UsersScope = {
	namespaces: [],
	services: [],
	serviceNamespaces: [
		["web", "storefront"],
		["api", "platform"],
	],
	mcpServices: ["mcp-server"],
}

const storefront: UsersScope = { ...unscoped, namespaces: ["storefront"], services: ["web"] }

const count = (sql: string, needle: string) => Str.split(sql, needle).length - 1

describe("usersListQuery", () => {
	it("filters OrgId in every source", () => {
		const { sql } = compileUnsafe(usersListQuery(unscoped), params)
		expect(sql).toContain("session_replays.OrgId = 'org_1'")
		expect(sql).toContain("product_events.OrgId = 'org_1'")
		expect(sql).toContain("traces.OrgId = 'org_1'")
		expect(count(sql, "UNION ALL")).toBe(2)
	})

	it("reads MCP spans only from MCP server services, keyed on user.id then enduser.id", () => {
		const { sql } = compileUnsafe(usersListQuery(unscoped), params)
		expect(sql).toContain("traces.ServiceName IN ('mcp-server')")
		expect(sql).toContain("traces.SpanKind = 'Server'")
		expect(sql).toContain(
			"if(traces.SpanAttributes['user.id'] != '', traces.SpanAttributes['user.id'], traces.SpanAttributes['enduser.id'])",
		)
	})

	it("drops the MCP source when no service answers MCP", () => {
		const { sql } = compileUnsafe(usersListQuery({ ...unscoped, mcpServices: [] }), params)
		expect(sql).not.toContain("FROM traces")
		expect(count(sql, "UNION ALL")).toBe(1)
	})

	it("labels replay and event rows with their service's namespace", () => {
		const { sql } = compileUnsafe(usersListQuery(unscoped), params)
		expect(sql).toContain(
			"transform(product_events.ServiceName, ['web', 'api'], ['storefront', 'platform'], '')",
		)
	})

	it("scopes replays and events to the namespace's services, and spans to the namespace", () => {
		const { sql } = compileUnsafe(usersListQuery(storefront), params)
		expect(sql).toContain("session_replays.ServiceName IN ('web')")
		expect(sql).toContain("product_events.ServiceName IN ('web')")
		expect(sql).toContain("traces.ResourceAttributes['service.namespace'] IN ('storefront')")
	})

	it("leaves the service sources unscoped when no namespace is in effect", () => {
		const { sql } = compileUnsafe(usersListQuery(unscoped), params)
		expect(sql).not.toContain("session_replays.ServiceName IN")
		expect(sql).not.toContain("product_events.ServiceName IN")
		expect(sql).not.toContain("['service.namespace'] IN")
	})

	it("skips replays and events when a scoped namespace has no service", () => {
		const scope = { ...unscoped, namespaces: ["nowhere"], services: [] }
		const { sql } = compileUnsafe(usersListQuery(scope), params)
		expect(sql).not.toContain("FROM session_replays")
		expect(sql).not.toContain("FROM product_events")
		expect(hasUserSources(scope)).toBe(true)
		expect(hasUserSources({ ...scope, mcpServices: [] })).toBe(false)
	})

	it("searches the id, name and email case-insensitively after merging sources", () => {
		const { sql } = compileUnsafe(usersListQuery(unscoped, { search: "Ada_1" }), params)
		expect(sql).toContain("positionCaseInsensitiveUTF8(signals.userId, 'Ada_1') > 0")
		expect(sql).toContain(
			"positionCaseInsensitiveUTF8(anyIf(signals.name, signals.name != ''), 'Ada_1') > 0",
		)
		expect(sql).toContain(
			"positionCaseInsensitiveUTF8(anyIf(signals.email, signals.email != ''), 'Ada_1') > 0",
		)
		expect(sql).not.toContain("ILIKE")
	})

	it("applies the toggles and groups per user, newest first", () => {
		const { sql } = compileUnsafe(
			usersListQuery(unscoped, { hasErrors: true, hasReplay: true, groups: ["acme"] }, 50),
			params,
		)
		expect(sql).toContain("HAVING sum(signals.errors) > 0")
		expect(sql).toContain("sum(signals.sessions) > 0")
		// Each source counts its rows in the selected groups before it keeps one `groupId`.
		expect(sql).toContain("countIf(product_events.GroupId IN ('acme'))")
		expect(sql).toContain("countIf(sessions.groupId IN ('acme'))")
		expect(sql).toContain("sum(signals.groupHits) > 0")
		expect(sql).toMatch(/ORDER BY lastSeen DESC\s+LIMIT 50/)
	})

	it("finalizes replay identity to the session's latest version", () => {
		const { sql } = compileUnsafe(usersListQuery(unscoped), params)
		expect(sql).toContain("argMax(session_replays.UserId, session_replays.Version) AS userId")
		expect(sql).toContain("GROUP BY sessionId")
	})
})

describe("usersFacetsQuery", () => {
	it("counts namespaces over its own scope and groups over the page's", () => {
		const { sql } = compileUnionUnsafe(usersFacetsQuery(storefront, unscoped), params)
		const [namespaces, groups] = Str.split(sql, "'namespace' AS facetType")
		expect(groups).toContain("'group' AS facetType")
		expect(groups).toContain("session_replays.ServiceName IN ('web')")
		expect(namespaces).not.toContain("session_replays.ServiceName IN")
		expect(count(sql, "session_replays.OrgId = 'org_1'")).toBe(2)
	})

	it("skips the namespace facet under a pin", () => {
		const { sql } = compileUnionUnsafe(usersFacetsQuery(storefront), params)
		expect(sql).not.toContain("'namespace' AS facetType")
	})
})

describe("usersSummaryQuery", () => {
	it("counts users per flag over the merged sources", () => {
		const { sql } = compileUnsafe(usersSummaryQuery(storefront), params)
		expect(sql).toContain("countIf(users.lastSeen >= '2026-06-24 06:00:00') AS activeToday")
		expect(sql).toContain("countIf(users.errors > 0) AS withErrors")
		expect(sql).toContain("product_events.OrgId = 'org_1'")
	})
})

describe("usersAnonymousVisitorsQuery", () => {
	it("keeps only visitors that never carried a user id, in scope", () => {
		const { sql } = compileUnsafe(usersAnonymousVisitorsQuery(storefront), params)
		expect(sql).toContain("HAVING sum(visitors.identified) = 0")
		expect(sql).toContain("session_replays.OrgId = 'org_1'")
		expect(sql).toContain("product_events.OrgId = 'org_1'")
		expect(sql).toContain("product_events.ServiceName IN ('web')")
	})
})

describe("one user's reads", () => {
	const userParams = { ...params, userId: "user_42" }

	it("filters OrgId and the exact user id in every read", () => {
		const sqls = [
			compileUnsafe(userReplayProfileQuery(unscoped), userParams).sql,
			compileUnsafe(userDevicesQuery(unscoped), userParams).sql,
			compileUnsafe(userEventsSummaryQuery(unscoped), userParams).sql,
			compileUnsafe(userEventsQuery(unscoped), userParams).sql,
			compileUnsafe(userMcpSummaryQuery(unscoped), userParams).sql,
			compileUnsafe(userServicesQuery(unscoped), userParams).sql,
			compileUnsafe(userVisitorIdsQuery(), userParams).sql,
		]
		Arr.forEach(sqls, (sql) => {
			expect(sql).toMatch(/OrgId = 'org_1'/)
			expect(sql).toContain("'user_42'")
		})
	})

	it("keys MCP spans on user.id then enduser.id, only from MCP servers", () => {
		const { sql } = compileUnsafe(userMcpSummaryQuery(unscoped), userParams)
		expect(sql).toContain(
			"if(traces.SpanAttributes['user.id'] != '', traces.SpanAttributes['user.id'], traces.SpanAttributes['enduser.id']) = 'user_42'",
		)
		expect(sql).toContain("traces.ServiceName IN ('mcp-server')")
	})

	it("narrows replays and events to the scoped services and MCP spans to the namespace", () => {
		expect(compileUnsafe(userEventsQuery(storefront), userParams).sql).toContain(
			"product_events.ServiceName IN ('web')",
		)
		expect(compileUnsafe(userReplayProfileQuery(storefront), userParams).sql).toContain(
			"session_replays.ServiceName IN ('web')",
		)
		expect(compileUnsafe(userMcpSummaryQuery(storefront), userParams).sql).toContain(
			"traces.ResourceAttributes['service.namespace'] IN ('storefront')",
		)
	})

	it("reads every source for services touched, dropping MCP when no server answers it", () => {
		expect(count(compileUnsafe(userServicesQuery(unscoped), userParams).sql, "UNION ALL")).toBe(2)
		const sql = compileUnsafe(userServicesQuery({ ...unscoped, mcpServices: [] }), userParams).sql
		expect(sql).not.toContain("FROM traces")
	})
})

describe("a namespace no service resolves to", () => {
	const ghost: UsersScope = { ...unscoped, namespaces: ["ghost"], services: [], mcpServices: ["maple-ai"] }

	it("reads no replays or events instead of emitting an empty IN list", () => {
		const { sql } = compileUnsafe(usersAnonymousVisitorsQuery(ghost), params)
		expect(sql).not.toContain("IN ()")
		expect(sql).toContain("1 = 0")
	})
})
