// ClickHouse refuses a query nested deeper than max_parser_depth (1000). A builder that chains
// `.or()` / `.and()` once per list item nests one level per item and reaches it at a few hundred,
// so a list input must never make the SQL deeper. Fixtures use one or two items and cannot see it.
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { ciActorStatsQuery } from "./ci-runs"
import { logsCountQuery } from "./logs"
import { tracesListQuery } from "./traces"

const params = { orgId: "org_nesting", startTime: "2026-10-01 00:00:00", endTime: "2026-10-02 00:00:00" }

/** Deepest parenthesis nesting outside string literals. */
const nestingDepth = (sql: string): number => {
	let depth = 0
	let deepest = 0
	let quoted = false
	for (let i = 0; i < sql.length; i++) {
		const char = sql[i]
		if (char === "\\" && quoted) i++
		else if (char === "'") quoted = !quoted
		else if (!quoted && char === "(") deepest = Math.max(deepest, ++depth)
		else if (!quoted && char === ")") depth--
	}
	return deepest
}

const listSize = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 2_000 }))

const items = <A>(n: number, make: (i: number) => A): ReadonlyArray<A> =>
	Array.from({ length: n }, (_, i) => make(i))
const words = (n: number) => items(n + 2, (i) => `word${i}`).join(" ")
const orGroup = (n: number) => ({
	key: "http.route",
	value: "/0",
	mode: "equals" as const,
	or: items(n, (i) => ({ key: "http.route", value: `/${i + 1}`, mode: "equals" as const })),
})
const filters = (n: number) => items(n, (i) => ({ key: `attr.${i}`, value: "v", mode: "equals" as const }))

const cases: ReadonlyArray<{ readonly name: string; readonly sql: (n: number) => string }> = [
	{
		name: "CI actor stats over many repositories' default branches",
		sql: (n) =>
			compileUnsafe(
				ciActorStatsQuery({
					defaultBranches: items(n, (i) => ({
						owner: "acme",
						repository: `repo-${i}`,
						branch: "main",
					})),
				}),
				params,
			).sql,
	},
	{
		name: "log search with many words (token index)",
		sql: (n) =>
			compileUnsafe(logsCountQuery({ search: words(n), bodySearchMode: "tokenbf" }), params).sql,
	},
	{
		name: "log search with many words (text index)",
		sql: (n) => compileUnsafe(logsCountQuery({ search: words(n), bodySearchMode: "text" }), params).sql,
	},
	{
		name: "log attribute OR group",
		sql: (n) => compileUnsafe(logsCountQuery({ attributeFilters: [orGroup(n)] }), params).sql,
	},
	{
		name: "many log attribute filters",
		sql: (n) => compileUnsafe(logsCountQuery({ attributeFilters: filters(n) }), params).sql,
	},
	{
		name: "span attribute OR group",
		sql: (n) => compileUnsafe(tracesListQuery({ attributeFilters: [orGroup(n)] }), params).sql,
	},
	{
		name: "many span attribute filters",
		sql: (n) => compileUnsafe(tracesListQuery({ attributeFilters: filters(n) }), params).sql,
	},
]

describe("list inputs never deepen the SQL", () => {
	for (const { name, sql } of cases) {
		const twoItems = nestingDepth(sql(2))
		it.prop(name, [listSize], ([n]) => {
			expect(nestingDepth(sql(n))).toBeLessThanOrEqual(twoItems)
		})
	}
})
