import { describe, expect, it } from "vitest"
import { String as Str } from "effect"
import { inlineNestedCteReads } from "./raw-sql-ctes"

const squash = (sql: string) => Str.trim(Str.replace(/\s+/g, " ")(sql))

describe("inlineNestedCteReads", () => {
	it("writes a CTE read by another CTE in place", () => {
		const sql = `WITH s AS (SELECT bucket, svc, v FROM metrics_gauge WHERE (OrgId = 'o')),
t AS (SELECT bucket, svc, sum(v) AS v FROM s GROUP BY bucket, svc)
SELECT bucket, v FROM t`
		expect(squash(inlineNestedCteReads(sql))).toBe(
			squash(`WITH s AS (SELECT bucket, svc, v FROM metrics_gauge WHERE (OrgId = 'o')),
t AS (SELECT bucket, svc, sum(v) AS v FROM (SELECT bucket, svc, v FROM metrics_gauge WHERE (OrgId = 'o')) AS s GROUP BY bucket, svc)
SELECT bucket, v FROM t`),
		)
	})

	it("writes CTEs read from scalar subqueries in place, keeping top-level reads", () => {
		const sql = `WITH calls AS (SELECT ServiceName AS svc, count() AS n FROM traces GROUP BY svc),
enqueue_failures AS (SELECT count() AS n FROM logs)
SELECT (SELECT n FROM enqueue_failures) + if((SELECT n FROM calls WHERE svc = 'api') > 0, 1, 0) AS value`
		const out = inlineNestedCteReads(sql)
		expect(out).toContain("(SELECT n FROM (SELECT count() AS n FROM logs) AS enqueue_failures)")
		expect(out).toContain(
			"(SELECT n FROM (SELECT ServiceName AS svc, count() AS n FROM traces GROUP BY svc) AS calls WHERE svc = 'api')",
		)
	})

	it("keeps an alias written after the CTE name and inlines chains transitively", () => {
		const sql = `WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a), c AS (SELECT x FROM b AS bb)
SELECT x FROM c`
		expect(squash(inlineNestedCteReads(sql))).toBe(
			squash(`WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM (SELECT 1 AS x) AS a),
c AS (SELECT x FROM (SELECT x FROM (SELECT 1 AS x) AS a) AS bb)
SELECT x FROM c`),
		)
	})

	it("writes `IN cte` as a subquery even at the top level", () => {
		const sql = "WITH ids AS (SELECT TraceId FROM traces) SELECT count() FROM logs WHERE TraceId IN ids"
		expect(inlineNestedCteReads(sql)).toBe(
			"WITH ids AS (SELECT TraceId FROM traces) SELECT count() FROM logs WHERE TraceId IN (SELECT TraceId FROM traces)",
		)
	})

	it.each([
		"SELECT count() FROM traces",
		"WITH s AS (SELECT 1 AS x) SELECT x FROM s",
		"WITH a AS (SELECT 1 AS k), b AS (SELECT 1 AS k) SELECT * FROM a JOIN b ON a.k = b.k",
		"WITH 10 AS lim, s AS (SELECT 1 AS x) SELECT x FROM s LIMIT lim",
		"WITH s AS (SELECT 'FROM s' AS x) SELECT x FROM s",
		"WITH RECURSIVE r AS (SELECT 1 AS n) SELECT n FROM r",
	])("leaves a query with no nested CTE read unchanged: %s", (sql) => {
		expect(inlineNestedCteReads(sql)).toBe(sql)
	})

	it("ignores a CTE name inside a string literal", () => {
		const sql = "WITH s AS (SELECT 1 AS x) SELECT x, (SELECT 'FROM s') AS label FROM s"
		expect(inlineNestedCteReads(sql)).toBe(sql)
	})
})
