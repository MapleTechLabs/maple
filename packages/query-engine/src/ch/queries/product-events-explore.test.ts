import { assert, describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, String as Str } from "effect"
import { compile, compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import {
	productEventAttributeKeysQuery,
	productEventAttributeValuesQuery,
	productEventsBreakdownQuery,
	productEventsListQuery,
	productEventsTimeseriesQuery,
} from "./product-events-explore"
import { OrgId } from "@maple/domain"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-06-24 04:00:00",
	endTime: "2026-06-25 06:00:00",
	bucketSeconds: 3600,
}

const oneLine = (sql: string): string => Str.replace(/\s+/g, " ")(sql)

describe("productEventsTimeseriesQuery", () => {
	it("scopes to the org and buckets on the parameter", () => {
		const compiled = compileUnsafe(productEventsTimeseriesQuery({ metric: "count" }), params)
		expect(compiled.tenantScope).toBe("single-tenant")
		expect(compiled.sql).toContain("FROM product_events")
		expect(compiled.sql).toContain("OrgId = 'org_1'")
		expect(compiled.sql).toContain(
			"toStartOfInterval(product_events.Timestamp, INTERVAL 3600 SECOND) AS bucket",
		)
		expect(compiled.sql).toContain("count() AS value")
		expect(compiled.sql).toContain("count() AS eventCount")
		expect(compiled.rowSchemaSource).toBe("derived")
	})

	it("lowers each metric to a guarded uniq", () => {
		const sqlFor = (metric: Parameters<typeof productEventsTimeseriesQuery>[0]["metric"]) =>
			oneLine(compileUnsafe(productEventsTimeseriesQuery({ metric }), params).sql)
		expect(sqlFor("sessions")).toContain(
			"uniqIf(product_events.SessionId, product_events.SessionId != '') AS value",
		)
		expect(sqlFor("users")).toContain(
			"uniqIf(product_events.UserId, product_events.UserId != '') AS value",
		)
		expect(sqlFor("visitors")).toContain(
			"uniqIf(product_events.VisitorId, product_events.VisitorId != '') AS value",
		)
		expect(sqlFor("persons")).toContain(
			"uniqIf(if(product_events.UserId != '', product_events.UserId, product_events.VisitorId), (product_events.UserId != '' OR product_events.VisitorId != '')) AS value",
		)
	})

	it("counts distinct groups, leaving out events that carry none", () => {
		const { sql } = compileUnsafe(productEventsTimeseriesQuery({ metric: "groups" }), params)
		expect(oneLine(sql)).toContain(
			"uniqIf(product_events.GroupId, product_events.GroupId != '') AS value",
		)
	})

	it("aggregates a numeric prop, reading text, NaN and infinity as no value", () => {
		const sqlFor = (metric: Parameters<typeof productEventsTimeseriesQuery>[0]["metric"]) =>
			oneLine(
				compileUnsafe(productEventsTimeseriesQuery({ metric, valueAttributeKey: "amount" }), params)
					.sql,
			)
		const value =
			"if(isFinite(toFloat64OrNull(product_events.Attributes['amount'])), toFloat64OrNull(product_events.Attributes['amount']), NULL)"
		// No values reads 0 whichever the aggregate answers for an empty set: NULL or NaN.
		expect(sqlFor("sum")).toContain(`ifNull(ifNotFinite(sum(${value}), 0), 0) AS value`)
		expect(sqlFor("avg")).toContain(`ifNull(ifNotFinite(avg(${value}), 0), 0) AS value`)
		expect(sqlFor("p95")).toContain(`ifNull(ifNotFinite(quantile(0.95)(${value}), 0), 0) AS value`)
		// The sample count is the rows that carry a number, not every row in the bucket.
		expect(sqlFor("sum")).toContain(`countIf(${value} IS NOT NULL) AS eventCount`)
	})

	it("reads a whole range up to its end, or through it when asked to match the bucketed read", () => {
		const halfOpen = "product_events.Timestamp < '2026-06-25 06:00:00'"
		const sqlFor = (closedEnd: boolean) =>
			oneLine(
				compileUnsafe(
					productEventsTimeseriesQuery({ metric: "count", wholeRange: true, closedEnd }),
					params,
				).sql,
			)
		expect(sqlFor(false)).toContain(halfOpen)
		expect(sqlFor(true)).not.toContain(halfOpen)
		expect(sqlFor(true)).toContain("product_events.Timestamp <= '2026-06-25 06:00:00'")
	})

	it("joins the sessions' dimensions only when a group-by reads one", () => {
		const plain = compileUnsafe(
			productEventsTimeseriesQuery({ metric: "count", groupBy: ["event_name"] }),
			params,
		).sql
		expect(plain).not.toContain("session_replays")

		const grouped = oneLine(
			compileUnsafe(
				productEventsTimeseriesQuery({ metric: "visitors", groupBy: ["country", "utm_source"] }),
				params,
			).sql,
		)
		expect(grouped).toContain("LEFT JOIN (SELECT")
		expect(grouped).toContain("max(session_replays.Country) AS country")
		expect(grouped).toContain("max(session_replays.UtmSource) AS utm_source")
		// The sessions are read under the caller's org, from a day before the window: a session
		// that started before it can still hold the window's events.
		expect(grouped).toContain("session_replays.OrgId = 'org_1'")
		expect(grouped).toContain(
			"session_replays.StartTime >= subtractHours(toDateTime('2026-06-24 04:00:00'), 24)",
		)
		expect(grouped).toContain("session_replays.SessionId != ''")

		// A filter on a session dimension reads the same sessions, so a group and the filter on it agree.
		const filtered = oneLine(
			compileUnsafe(productEventsTimeseriesQuery({ metric: "count", country: "DE" }), params).sql,
		)
		expect(filtered).toContain(
			"session_replays.StartTime >= subtractHours(toDateTime('2026-06-24 04:00:00'), 24)",
		)
		expect(filtered).not.toContain("session_replays.StartTime >= '2026-06-24 04:00:00'")
		expect(grouped).toContain("product_events.SessionId = sd.SessionId")
		// An event with no session groups as unset, not as a dropped row.
		expect(grouped).toContain("coalesce(nullIf(coalesce(sd.country, ''), ''), '(none)')")
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
		expect(oneLine(sql)).toContain("coalesce(nullIf(product_events.EventName, ''), '(none)')")
		expect(oneLine(sql)).toContain("coalesce(nullIf(product_events.Attributes['plan'], ''), '(none)')")
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
		expect(flat).toContain(
			"product_events.SessionId IN (SELECT session_replays.SessionId AS sessionId FROM session_replays",
		)
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
		expect(sql).toContain("__series_rank <= 5")
	})
})

describe("productEventsBreakdownQuery", () => {
	it("names the group by the raw column and orders by value", () => {
		const { sql } = compileUnsafe(
			productEventsBreakdownQuery({ metric: "sessions", groupBy: "page_path", limit: 25 }),
			params,
		)
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- groupBy picks the grouped column
		expect(sql).toContain("PagePath AS name")
		expect(sql).toContain("uniqIf(product_events.SessionId, product_events.SessionId != '') AS value")
		expect(sql).toContain("ORDER BY value DESC, name ASC")
		expect(sql).toContain("LIMIT 25")
	})
})

describe("productEventsListQuery", () => {
	it("filters by service and returns newest first, seq breaking ties", () => {
		const { sql } = compileUnsafe(
			productEventsListQuery({ limit: 20, serviceNames: ["maple-api"] }),
			params,
		)
		expect(sql).toContain("ServiceName IN ('maple-api')")
		expect(sql).toContain("ORDER BY timestamp DESC, seq DESC")
		expect(sql).toContain("LIMIT 20")
	})
})

describe("attribute discovery", () => {
	it("lists keys by array-joining the map keys", () => {
		const { sql } = compileUnsafe(productEventAttributeKeysQuery({ limit: 10 }), params)
		expect(sql).toContain("arrayJoin(mapKeys(product_events.Attributes)) AS attributeKey")
		expect(sql).toContain("GROUP BY attributeKey")
	})

	it("lists values for one key only where the key is present", () => {
		const { sql } = compileUnsafe(productEventAttributeValuesQuery({ attributeKey: "plan" }), params)
		expect(sql).toContain("has(mapKeys(product_events.Attributes), 'plan')")
	})
})

// Rows reach callers through `decodeRows`; an underived (or untyped series-cap)
// row schema would leave timestamps strings behind a `DateTime.Utc` type.
describe("product event rows decode timestamps to DateTime.Utc", () => {
	const tsRow = { bucket: "2026-06-24 04:00:00.000000000", groupName: "all", value: 1, eventCount: 1 }

	for (const [name, opts] of [
		["timeseries", { metric: "count" }],
		["timeseries, series-capped", { metric: "count", groupBy: ["event_name"], seriesLimit: 5 }],
	] as const) {
		it.effect(name, () =>
			Effect.gen(function* () {
				const compiled = yield* compile(productEventsTimeseriesQuery(opts), params)
				expect(compiled.rowSchemaSource).not.toBe("none")
				const [row] = yield* compiled.decodeRows([tsRow])
				assert.isDefined(row)
				expect(DateTime.toEpochMillis(row.bucket)).toBe(Date.UTC(2026, 5, 24, 4))
			}),
		)
	}

	it.effect("productEventsListQuery", () =>
		Effect.gen(function* () {
			const compiled = yield* compile(productEventsListQuery({}), params)
			expect(compiled.rowSchemaSource).toBe("derived")
			const [row] = yield* compiled.decodeRows([
				{
					timestamp: "2026-06-24 04:00:00.250000000",
					eventName: "signup",
					kind: "track",
					source: "browser",
					host: "",
					pagePath: "",
					url: "",
					serviceName: "",
					userId: "",
					groupId: "",
					visitorId: "",
					sessionId: "",
					traceId: "",
					spanId: "",
					attributes: {},
					seq: 0,
				},
			])
			assert.isDefined(row)
			expect(DateTime.formatIso(row.timestamp)).toBe("2026-06-24T04:00:00.250Z")
		}),
	)
})
