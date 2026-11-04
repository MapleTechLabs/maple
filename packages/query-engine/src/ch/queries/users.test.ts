import { describe, expect, it } from "@effect/vitest"
import { compileUnionUnsafe, compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	hasUserSources,
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

const count = (sql: string, needle: string) => sql.split(needle).length - 1

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
		expect(sql).toContain("signals.userId ILIKE '%Ada\\\\_1%'")
		expect(sql).toContain("anyIf(signals.name, signals.name != '') ILIKE '%Ada\\\\_1%'")
		expect(sql).toContain("anyIf(signals.email, signals.email != '') ILIKE '%Ada\\\\_1%'")
	})

	it("applies the toggles and groups per user, newest first", () => {
		const { sql } = compileUnsafe(
			usersListQuery(unscoped, { hasErrors: true, hasReplay: true, groups: ["acme"] }, 50),
			params,
		)
		expect(sql).toContain("HAVING sum(signals.errors) > 0")
		expect(sql).toContain("sum(signals.sessions) > 0")
		expect(sql).toContain("anyIf(signals.groupId, signals.groupId != '') IN ('acme')")
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
		const [namespaces, groups] = sql.split("'namespace' AS facetType")
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
