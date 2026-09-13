import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-clickhouse"
import { ProductEventsFunnelError } from "./product-events"
import { productEventsPathsQuery, type ProductEventsPathsOpts } from "./product-events-paths"

const params = { orgId: "org_1", startTime: "2026-06-24 04:00:00", endTime: "2026-06-25 06:00:00" }

const base: ProductEventsPathsOpts = {
	anchor: { kind: "event", eventName: "signup_completed" },
	direction: "after",
	depth: 3,
	branches: 4,
	keyBy: "person",
	windowSeconds: 86_400,
}

// productEventsPathsQuery
//
// Per person: the sorted events, cut at the anchor, bounded by the window,
// compacted and truncated to `depth` hops; then one row per hop with the top
// `branches` nodes per column named and the rest folded into `$other`.

describe("productEventsPathsQuery", () => {
	it("scopes every table it reads to the org and derives an org-scoped result", () => {
		const compiled = compileUnsafe(productEventsPathsQuery(base), params)
		expect(compiled.tenantScope).toBe("single-tenant")
		expect(compiled.sql).toContain("FROM product_events AS e")
		expect(compiled.sql).toContain("FROM identity_links")
		expect(compiled.sql.match(/OrgId = 'org_1'/g)?.length).toBeGreaterThanOrEqual(2)
	})

	it("walks forward from the first anchor within the window, `depth + 1` names per person", () => {
		const { sql } = compileUnsafe(productEventsPathsQuery(base), params)
		expect(sql).toContain("toUInt8(e.EventName = 'signup_completed') AS isAnchor")
		expect(sql).toContain("arrayFirstIndex(x -> x.3 = 1, evs) AS anchorIdx")
		expect(sql).toContain("x.1 <= anchorTs + 86400000")
		expect(sql).toContain(", 1, 4) AS seq")
		expect(sql).toContain("WHERE anchorIdx > 0")
		expect(sql).toContain("WHERE tupleElement(edge, 1) <= 3")
		expect(sql).toContain("groupArray(tuple(name, n))), 1, 4) AS head")
		expect(sql).toContain("'$other'")
	})

	it("reads the array backwards for `before`, bounding the window behind the anchor", () => {
		const { sql } = compileUnsafe(
			productEventsPathsQuery({ ...base, direction: "before", windowSeconds: 3_600 }),
			params,
		)
		expect(sql).toContain("arrayFirstIndex(x -> x.3 = 1, arrayReverse(evs))")
		expect(sql).toContain("x.1 >= anchorTs - 3600000")
	})

	it("only reads persons who have the anchor, and computes the hop rows once as a CTE", () => {
		const { sql } = compileUnsafe(productEventsPathsQuery(base), params)
		expect(sql).toContain("WITH path_hops AS")
		expect(sql).toContain("FROM path_hops AS h")
		expect(sql.match(/FROM product_events AS e/g)?.length).toBe(2)
	})

	it("names page views by path and applies include / exclude before sequencing", () => {
		const { sql } = compileUnsafe(
			productEventsPathsQuery({
				...base,
				anchor: { kind: "page", pagePath: "/pricing", host: "maple.dev" },
				include: "pages",
				exclude: ["heartbeat", "/"],
				keyBy: "session",
			}),
			params,
		)
		// No identity join on a session key, so the columns go unprefixed.
		expect(sql).toContain("if(Kind = 'navigation', PagePath, EventName) AS name")
		expect(sql).toContain("AND Kind = 'navigation'")
		expect(sql).toContain("NOT IN ('heartbeat', '/')")
		expect(sql).toContain("(Kind = 'navigation' AND PagePath = '/pricing') AND Host = 'maple.dev'")
		expect(sql).toContain("SessionId AS key")
		expect(sql).not.toContain("identity_links")
	})

	it("narrows the population by person when a filter is set", () => {
		const { sql } = compileUnsafe(
			productEventsPathsQuery({ ...base, filters: { country: "DE" } }),
			params,
		)
		expect(sql).toContain("FROM session_replays AS s")
		expect(sql).toContain("Country = 'DE'")
	})

	it("rejects a definition the reader could not draw", () => {
		const reasons = (opts: ProductEventsPathsOpts) => {
			try {
				productEventsPathsQuery(opts)
				return null
			} catch (error) {
				return error instanceof ProductEventsFunnelError ? error.reason : "other"
			}
		}
		expect(reasons({ ...base, depth: 0 })).toBe("InvalidLimit")
		expect(reasons({ ...base, depth: 6 })).toBe("InvalidLimit")
		expect(reasons({ ...base, branches: 11 })).toBe("InvalidLimit")
		expect(reasons({ ...base, windowSeconds: 0 })).toBe("InvalidWindow")
		expect(reasons({ ...base, anchor: { kind: "event", eventName: " " } })).toBe("NoSteps")
		expect(reasons(base)).toBeNull()
	})
})
