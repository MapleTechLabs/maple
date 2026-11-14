import { describe, expect, it } from "vitest"
import { Result, String as Str, Array as Arr } from "effect"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import {
	productEventsFunnelQuery,
	productEventsFunnelBreakdownQuery,
	productEventNamesQuery,
	productEventsFunnelTimingQuery,
	productEventsFunnelLeaversQuery,
	ProductEventsFunnelError,
	type FunnelStep,
} from "./product-events"
import { OrgId } from "@maple/domain"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-06-24 04:00:00",
	endTime: "2026-06-25 06:00:00",
}

const STEPS: ReadonlyArray<FunnelStep> = [
	{ kind: "page", pagePath: "/pricing", host: "maple.dev" },
	{ kind: "event", eventName: "signup_completed" },
	{ kind: "event", eventName: "plan_started", attributeEquals: { plan: "startup" } },
]
const REFERRAL: FunnelStep = { kind: "session", dimension: "referrerHost", value: "news.ycombinator.com" }

const oneLine = (sql: string): string => Str.replace(/\s+/g, " ")(sql)

const rejection = (built: Result.Result<unknown, ProductEventsFunnelError>) =>
	Result.isFailure(built) ? built.failure : undefined

// One walk per person over the rows matching any step, then
// `countIf(level >= n)` per step, unpacked to `{ step, count }` rows.

describe("productEventsFunnelQuery", () => {
	it("scopes every table it reads to the org and derives an org-scoped result", () => {
		const compiled = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelQuery({
					steps: [REFERRAL, ...STEPS],
					keyBy: "person",
					windowSeconds: 86_400,
				}),
			),
			params,
		)
		expect(compiled.tenantScope).toBe("single-tenant")
		// product_events, session_replays (session step) and identity_links (person key).
		expect(compiled.sql).toContain("FROM product_events")
		expect(compiled.sql).toContain("FROM session_replays")
		expect(compiled.sql).toContain("FROM identity_links")
		expect(
			Arr.fromIterable(Str.matchAll(/OrgId = 'org_1'/g)(compiled.sql)).length,
		).toBeGreaterThanOrEqual(4)
	})

	it("walks each person's rows once per step and emits one output row per step", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelQuery({ steps: STEPS, keyBy: "visitor", windowSeconds: 3_600 }),
			),
			params,
		)
		// The window compares milliseconds (the order key without its Seq): 3600 s.
		expect(sql).toContain("intDiv(x.1, 1048576) <= intDiv(p, 1048576) + 3600000")
		expect(sql).toContain(
			"plus(multiply(toUInt64(toUnixTimestamp64Milli(e.Timestamp)), 1048576), modulo(e.Seq, 1048576)) AS ord",
		)
		expect(sql).toContain("[countIf(level >= 1), countIf(level >= 2), countIf(level >= 3)] AS counts")
		expect(sql).toContain("arrayJoin([1, 2, 3]) AS step")
		expect(sql).toContain("arrayElement(totals.counts, step) AS count")
		expect(sql).toContain("ORDER BY step ASC")
	})

	it("projects each step as a flag and only reads rows matching some step", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelQuery({ steps: STEPS, keyBy: "visitor", windowSeconds: 3_600 }),
			),
			params,
		)
		expect(sql).toContain(
			"toUInt8(((e.Kind IN ('navigation', 'screen') AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s1",
		)
		expect(sql).toContain("toUInt8(e.EventName = 'signup_completed') AS s2")
		expect(sql).toContain(
			"toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s3",
		)
		expect(oneLine(sql)).toContain(
			"AND (((e.Kind IN ('navigation', 'screen') AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed' OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))",
		)
	})

	it("keys by the raw column for visitor / user / session and drops empty keys", () => {
		const visitor = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelQuery({ steps: STEPS, keyBy: "visitor", windowSeconds: 60 }),
			),
			params,
		).sql
		expect(visitor).toContain("VisitorId AS key")
		expect(visitor).toContain("AND e.VisitorId != ''")
		expect(visitor).not.toContain("identity_links")

		const user = compileUnsafe(
			Result.getOrThrow(productEventsFunnelQuery({ steps: STEPS, keyBy: "user", windowSeconds: 60 })),
			params,
		).sql
		expect(user).toContain("UserId AS key")
		expect(user).toContain("AND e.UserId != ''")

		const session = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelQuery({ steps: STEPS, keyBy: "session", windowSeconds: 60 }),
			),
			params,
		).sql
		expect(session).toContain("SessionId AS key")
		expect(session).toContain("AND e.SessionId != ''")
	})

	it("stitches the person key through identity_links aggregated per visitor", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(productEventsFunnelQuery({ steps: STEPS, keyBy: "person", windowSeconds: 60 })),
			params,
		)
		// `min(FirstSeen)` per pair BEFORE the argMin: identity_links holds one
		// row per sighting until the AggregatingMergeTree merge collapses them,
		// so ranking a visitor's users on a raw FirstSeen would count arbitrary
		// duplicates until parts merge.
		expect(oneLine(sql)).toContain(
			"LEFT JOIN (SELECT pair_links.VisitorId AS VisitorId, argMin(pair_links.UserId, pair_links.FirstSeen) AS UserId FROM (SELECT identity_links.VisitorId AS VisitorId, identity_links.UserId AS UserId, min(identity_links.FirstSeen) AS FirstSeen FROM identity_links WHERE identity_links.OrgId = 'org_1' GROUP BY VisitorId, UserId) AS pair_links GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId",
		)
		expect(sql).toContain(
			"multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key",
		)
	})

	it("turns a session step 1 into a UNION ALL branch of session_replays entries", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelQuery({
					steps: [REFERRAL, ...STEPS],
					keyBy: "visitor",
					windowSeconds: 86_400,
				}),
			),
			params,
		)
		// The session branch: s1 = 1, every other step 0, at the session's StartTime.
		expect(oneLine(sql)).toContain(
			"SELECT s.VisitorId AS key, plus(multiply(toUInt64(toUnixTimestamp64Milli(s.StartTime)), 1048576), modulo(0, 1048576)) AS ord, 1 AS s1, 0 AS s2, 0 AS s3, 0 AS s4 FROM session_replays AS s",
		)
		expect(sql).toContain("AND s.ReferrerHost = 'news.ycombinator.com'")
		// The events branch never satisfies the session step.
		expect(oneLine(sql)).toContain(
			"SELECT e.VisitorId AS key, plus(multiply(toUInt64(toUnixTimestamp64Milli(e.Timestamp)), 1048576), modulo(e.Seq, 1048576)) AS ord, 0 AS s1,",
		)
	})

	it("has no session_replays branch without a session step", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelQuery({ steps: STEPS, keyBy: "visitor", windowSeconds: 60 }),
			),
			params,
		)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).not.toContain("session_replays")
	})

	it("narrows the population by person, not by session, when filters are set", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelQuery({
					steps: STEPS,
					keyBy: "person",
					windowSeconds: 60,
					filters: { country: "DE", pagePath: "/" },
				}),
			),
			params,
		)
		const flat = oneLine(sql)
		// The persons subquery resolves the key the same way as the events do…
		expect(flat).toContain(
			"IN (SELECT multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) AS key FROM session_replays AS s LEFT JOIN",
		)
		// …applies the replays dimension directly…
		expect(flat).toContain("AND s.Country = 'DE'")
		// …and the page filter through the navigation semi-join on product_events.
		expect(flat).toContain(
			"AND s.SessionId IN (SELECT product_events.SessionId AS sessionId FROM product_events WHERE product_events.OrgId = 'org_1'",
		)
		expect(flat).toContain(
			"AND product_events.Kind = 'navigation' AND product_events.PagePath = '/' GROUP BY sessionId)",
		)
	})

	it("omits the population subquery when no filter is set", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(productEventsFunnelQuery({ steps: STEPS, keyBy: "person", windowSeconds: 60 })),
			params,
		)
		expect(sql).not.toContain(" IN (SELECT")
	})

	it("rejects funnels it cannot compile", () => {
		expect(
			rejection(productEventsFunnelQuery({ steps: [], keyBy: "person", windowSeconds: 60 })),
		).toBeInstanceOf(ProductEventsFunnelError)
		expect(
			rejection(
				productEventsFunnelQuery({
					steps: [Arr.getUnsafe(STEPS, 0), REFERRAL],
					keyBy: "person",
					windowSeconds: 60,
				}),
			)?.message,
		).toMatch(/only valid as step 1/)
		expect(
			rejection(productEventsFunnelQuery({ steps: STEPS, keyBy: "person", windowSeconds: 0 }))?.message,
		).toMatch(/windowSeconds/)
		expect(
			rejection(
				productEventsFunnelQuery({
					steps: Array.from({ length: 11 }, () => Arr.getUnsafe(STEPS, 1)),
					keyBy: "person",
					windowSeconds: 60,
				}),
			)?.message,
		).toMatch(/at most 10 steps/)
	})
})

describe("productEventsFunnelBreakdownQuery", () => {
	it("groups persons by the first non-empty dimension value and keeps the top N by step-1 count", () => {
		const compiled = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelBreakdownQuery({
					steps: STEPS,
					keyBy: "visitor",
					windowSeconds: 3_600,
					breakdownBy: "attribute:plan",
					limit: 5,
				}),
			),
			params,
		)
		expect(compiled.tenantScope).toBe("single-tenant")
		const flat = oneLine(compiled.sql)
		expect(flat).toContain("Attributes['plan'] AS dim")
		expect(flat).toContain(
			"argMinIf(funnel_events.dim, funnel_events.ord, funnel_events.dim != '') AS group",
		)
		expect(flat).toContain("countIf(level >= 1) AS entered")
		expect(flat).toContain("GROUP BY group ORDER BY entered DESC, group ASC LIMIT 5")
		expect(flat).toContain(
			"SELECT groups.group AS group, arrayJoin([1, 2, 3]) AS step, arrayElement(groups.counts, step) AS count",
		)
		expect(flat).toContain("ORDER BY group ASC, step ASC")
	})

	it("reads a session dimension through a per-session join on session_replays", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelBreakdownQuery({
					steps: STEPS,
					keyBy: "visitor",
					windowSeconds: 3_600,
					breakdownBy: "utmSource",
				}),
			),
			params,
		)
		const flat = oneLine(sql)
		expect(flat).toContain("coalesce(sd.Value, '') AS dim")
		expect(flat).toContain(
			"LEFT JOIN (SELECT session_replays.SessionId AS SessionId, max(session_replays.UtmSource) AS Value FROM session_replays WHERE session_replays.OrgId = 'org_1'",
		)
		expect(flat).toContain("AS sd ON e.SessionId = sd.SessionId")
		expect(flat).toContain("LIMIT 10")
	})

	it("reads the dimension straight off the session row on the session-step branch", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelBreakdownQuery({
					steps: [REFERRAL, ...STEPS],
					keyBy: "visitor",
					windowSeconds: 3_600,
					breakdownBy: "country",
				}),
			),
			params,
		)
		expect(oneLine(sql)).toContain("0 AS s4, s.Country AS dim FROM session_replays AS s")
	})

	it("uses the event Host without a join", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelBreakdownQuery({
					steps: STEPS,
					keyBy: "visitor",
					windowSeconds: 60,
					breakdownBy: "host",
				}),
			),
			params,
		)
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- breakdownBy picks the grouped column
		expect(sql).toContain("Host AS dim")
		expect(sql).not.toContain("session_replays")
	})

	it("bounds the group limit", () => {
		expect(() =>
			Result.getOrThrow(
				productEventsFunnelBreakdownQuery({
					steps: STEPS,
					keyBy: "visitor",
					windowSeconds: 60,
					breakdownBy: "host",
					limit: 21,
				}),
			),
		).toThrow(/1\.\.20/)
	})
})

describe("productEventNamesQuery", () => {
	it("lists names with counts, sessions and persons, most frequent first", () => {
		const compiled = compileUnsafe(productEventNamesQuery({ limit: 25 }), params)
		expect(compiled.tenantScope).toBe("single-tenant")
		const flat = oneLine(compiled.sql)
		expect(flat).toContain(
			"SELECT product_events.EventName AS eventName, product_events.Kind AS kind, count() AS count, uniqIf(product_events.SessionId, product_events.SessionId != '') AS sessions, uniq(if(product_events.UserId != '', product_events.UserId, product_events.VisitorId)) AS persons FROM product_events",
		)
		expect(flat).toContain("WHERE product_events.OrgId = 'org_1'")
		expect(flat).toContain("GROUP BY eventName, kind ORDER BY count DESC, eventName ASC LIMIT 25")
		expect(flat).not.toContain("session_replays")
	})

	it("applies host directly and other filters through the session semi-join", () => {
		const { sql } = compileUnsafe(
			productEventNamesQuery({
				filters: { host: "maple.dev", referrerHost: "t.co", pagePath: "/pricing" },
			}),
			params,
		)
		const flat = oneLine(sql)
		expect(flat).toContain(
			"AND product_events.Host = 'maple.dev' AND product_events.SessionId IN (SELECT session_replays.SessionId AS sessionId FROM session_replays",
		)
		expect(flat).toContain("AND session_replays.ReferrerHost = 't.co'")
		// pagePath narrows sessions through the navigation semi-join, not the events.
		expect(flat).toContain(
			"AND product_events.Kind = 'navigation' AND product_events.PagePath = '/pricing' GROUP BY sessionId)",
		)
	})
})

// The drop-off view's extras. Both walk each person's chain from the first
// step-1 event (`t1..tN`); timing takes quantiles of the gaps, leavers join
// every event of the population back onto the chain to find what came next.

describe("funnel drop-off details", () => {
	it("walks the chain from the start that reached the deepest step and takes p50/p90 of the gaps", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelTimingQuery({ steps: STEPS, keyBy: "person", windowSeconds: 3_600 }),
			),
			params,
		)
		// Rows that tie on the order key sort in step order.
		expect(sql).toContain(
			"arraySort(x -> (x.1, 1 - x.2, 1 - x.3, 1 - x.4), groupArray(tuple(ord, s1, s2, s3))) AS evs",
		)
		// The first step-1 row still inside the window when the deepest step was first reached.
		expect(sql).toContain(
			"arrayFirstIndex(x -> x.2 = 1 AND intDiv(x.1, 1048576) + 3600000 >= intDiv(reachedAt, 1048576), evs)",
		)
		// Each later step is the first matching row after the previous step's, by position.
		expect(sql).toContain("arrayFirstIndex((x, i) -> x.3 = 1 AND i > i1, evs, arrayEnumerate(evs))")
		expect(sql).toContain(
			"quantileIf(0.5)(toFloat64(intDiv(o2, 1048576) - intDiv(o1, 1048576)), level >= 2)",
		)
		expect(sql).toContain(
			"quantileIf(0.9)(toFloat64(intDiv(o3, 1048576) - intDiv(o2, 1048576)), level >= 3)",
		)
		expect(sql).toContain("arrayJoin([2, 3]) AS step")
		expect(sql).toContain("arrayElement(totals.p50s, step) AS p50Ms")
	})

	it("finds the first event after the last step a leaver reached, top rows per step", () => {
		const { sql } = compileUnsafe(
			Result.getOrThrow(
				productEventsFunnelLeaversQuery({ steps: STEPS, keyBy: "visitor", windowSeconds: 3_600 }),
			),
			params,
		)
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- steps are 1-based, the chain level 0-based
		expect(sql).toContain("level + 1 AS step")
		expect(sql).toContain("arrayElement([o1, o2, o3], level) AS lastOrd")
		expect(sql).toContain("WHERE chain.level >= 1")
		expect(sql).toContain("AND chain.level < 3")
		expect(sql).toContain("coalesce(e.ord, 0) > d.lastOrd) AS next")
		// No identity join on a visitor key, so the branch's columns go unprefixed.
		expect(sql).toContain(
			"if((e.Kind IN ('navigation', 'screen') AND e.PagePath != ''), e.PagePath, e.EventName) AS name",
		)
		expect(sql).toContain("groupArray(tuple(next, count))), 1, 6) AS head")
		expect(sql).toContain("ORDER BY step ASC, count DESC, next ASC")
	})

	it("refuses a window longer than the events are kept", () => {
		const steps = STEPS
		expect(
			rejection(productEventsFunnelQuery({ steps, keyBy: "person", windowSeconds: 366 * 86_400 })),
		).toBeUndefined()
		expect(
			rejection(productEventsFunnelQuery({ steps, keyBy: "person", windowSeconds: 367 * 86_400 })),
		).toMatchObject({ reason: "InvalidWindow" })
	})

	it("need two steps — there is no 'between' with one", () => {
		const one = [Arr.getUnsafe(STEPS, 0)]
		expect(
			rejection(productEventsFunnelTimingQuery({ steps: one, keyBy: "person", windowSeconds: 60 })),
		).toBeInstanceOf(ProductEventsFunnelError)
		expect(
			rejection(productEventsFunnelLeaversQuery({ steps: one, keyBy: "person", windowSeconds: 60 })),
		).toBeInstanceOf(ProductEventsFunnelError)
	})
})
