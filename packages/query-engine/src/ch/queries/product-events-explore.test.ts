import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-clickhouse"
import {
	productEventAttributeKeysQuery,
	productEventAttributeValuesQuery,
	productEventsBreakdownQuery,
	productEventsListQuery,
	productEventsTimeseriesQuery,
} from "./product-events-explore"

const params = {
	orgId: "org_1",
	startTime: "2026-06-24 04:00:00",
	endTime: "2026-06-25 06:00:00",
	bucketSeconds: 3600,
}

const oneLine = (sql: string): string => sql.replace(/\s+/g, " ")

describe("productEventsTimeseriesQuery", () => {
	it("scopes to the org and buckets on the parameter", () => {
		const compiled = compileUnsafe(productEventsTimeseriesQuery({ metric: "count" }), params)
		expect(compiled.tenantScope).toBe("single-tenant")
		expect(compiled.sql).toContain("FROM product_events")
		expect(compiled.sql).toContain("OrgId = 'org_1'")
		expect(compiled.sql).toContain("toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket")
		expect(compiled.sql).toContain("'all' AS groupName")
		expect(compiled.sql).toContain("count() AS value")
		expect(compiled.rowSchemaSource).toBe("derived")
	})

	it("lowers each metric to a guarded uniq", () => {
		const sqlFor = (metric: Parameters<typeof productEventsTimeseriesQuery>[0]["metric"]) =>
			oneLine(compileUnsafe(productEventsTimeseriesQuery({ metric }), params).sql)
		expect(sqlFor("sessions")).toContain("uniqIf(SessionId, SessionId != '') AS value")
		expect(sqlFor("users")).toContain("uniqIf(UserId, UserId != '') AS value")
		expect(sqlFor("visitors")).toContain("uniqIf(VisitorId, VisitorId != '') AS value")
		expect(sqlFor("persons")).toContain(
			"uniqIf(if(UserId != '', UserId, VisitorId), (UserId != '' OR VisitorId != '')) AS value",
		)
	})

	it("groups by an event column and an attribute key", () => {
		const { sql } = compileUnsafe(
			productEventsTimeseriesQuery({
				metric: "count",
				groupBy: ["event_name", "attribute"],
				groupByAttributeKey: "plan",
			}),
			params,
		)
		expect(oneLine(sql)).toContain("toString(EventName)")
		expect(oneLine(sql)).toContain("toString(Attributes['plan'])")
		expect(sql).toContain("GROUP BY bucket, groupName")
	})

	it("applies event-side filters directly and session filters through the replays semi-join", () => {
		const { sql } = compileUnsafe(
			productEventsTimeseriesQuery({
				metric: "count",
				eventNames: ["signup_completed", "plan_started"],
				kinds: ["custom"],
				excludedHosts: ["localhost"],
				attributeFilters: [{ key: "plan", value: "startup", mode: "equals" }],
				country: "DE",
			}),
			params,
		)
		const flat = oneLine(sql)
		expect(flat).toContain("EventName IN ('signup_completed', 'plan_started')")
		expect(flat).toContain("Kind IN ('custom')")
		expect(flat).toContain("Host NOT IN ('localhost')")
		expect(flat).toContain("Attributes['plan'] = 'startup'")
		expect(flat).toContain("SessionId IN (SELECT SessionId AS sessionId FROM session_replays")
		expect(flat).toContain("Country = 'DE'")
	})

	it("skips the semi-join when only event-side filters are set", () => {
		const { sql } = compileUnsafe(
			productEventsTimeseriesQuery({ metric: "count", hosts: ["maple.dev"] }),
			params,
		)
		expect(sql).not.toContain("session_replays")
	})

	it("caps series when a group-by and a limit are given", () => {
		const { sql } = compileUnsafe(
			productEventsTimeseriesQuery({ metric: "count", groupBy: ["event_name"], seriesLimit: 5 }),
			params,
		)
		expect(sql).toContain("__series_peak")
	})
})

describe("productEventsBreakdownQuery", () => {
	it("names the group by the raw column and orders by value", () => {
		const { sql } = compileUnsafe(
			productEventsBreakdownQuery({ metric: "sessions", groupBy: "page_path", limit: 25 }),
			params,
		)
		expect(sql).toContain("PagePath AS name")
		expect(sql).toContain("uniqIf(SessionId, SessionId != '') AS value")
		expect(sql).toContain("ORDER BY value DESC, name ASC")
		expect(sql).toContain("LIMIT 25")
	})
})

describe("productEventsListQuery", () => {
	it("returns the row columns newest first and pages on the cursor", () => {
		const { sql } = compileUnsafe(
			productEventsListQuery({ limit: 20, cursor: "2026-06-25 05:00:00", serviceNames: ["maple-api"] }),
			params,
		)
		expect(sql).toContain("Attributes AS attributes")
		expect(sql).toContain("TraceId AS traceId")
		expect(sql).toContain("Timestamp < '2026-06-25 05:00:00'")
		expect(sql).toContain("ServiceName IN ('maple-api')")
		expect(sql).toContain("ORDER BY timestamp DESC")
		expect(sql).toContain("LIMIT 20")
	})
})

describe("attribute discovery", () => {
	it("lists keys by array-joining the map keys", () => {
		const { sql } = compileUnsafe(productEventAttributeKeysQuery({ limit: 10 }), params)
		expect(sql).toContain("arrayJoin(mapKeys(Attributes)) AS attributeKey")
		expect(sql).toContain("GROUP BY attributeKey")
	})

	it("lists values for one key only where the key is present", () => {
		const { sql } = compileUnsafe(productEventAttributeValuesQuery({ attributeKey: "plan" }), params)
		expect(sql).toContain("Attributes['plan'] AS attributeValue")
		expect(sql).toContain("has(mapKeys(Attributes), 'plan')")
	})
})
