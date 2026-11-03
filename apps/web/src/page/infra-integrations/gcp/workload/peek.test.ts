import { describe, expect, test } from "vitest"
import type { GcpStatement, GcpTracedStatement } from "../../../../components/infra/gcp/cloud-sql-signals"
import { resolveQueryPeek, statementSpansInput, statementTracesHref } from "./peek"

const statement = (queryHash: string, querystring: string): GcpStatement => ({
	queryHash,
	querystring,
	calls: 100,
	p50LatencyMillis: 4,
	p95LatencyMillis: 12,
	totalExecutionMillis: 800,
	executionShare: 0.2,
	rows: 100,
	lockShare: 0,
	ioShare: 0,
})

const traced = (services: ReadonlyArray<string>, serviceCount: number): GcpTracedStatement => ({
	services,
	serviceCount,
	appP95Ms: 40,
	queryKeys: ["1449", "2077"],
})

const rows = [statement("a", "SELECT id, status FROM orders WHERE org_id = $1"), statement("b", "SELECT $1")]
const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }

const searchOf = (href: string) => new URL(href, "https://app.maple.dev").searchParams

describe("resolveQueryPeek", () => {
	test("finds the statement and where it sits in the table", () => {
		const peek = resolveQueryPeek(rows, new Map(), ["orders"], "b")
		expect(peek?.statement.queryHash).toBe("b")
		expect([peek?.index, peek?.count]).toEqual([1, 2])
	})

	test("a hash no statement has, or none, is no peek", () => {
		expect(resolveQueryPeek(rows, new Map(), [], "gone")).toBeNull()
		expect(resolveQueryPeek(rows, new Map(), [], undefined)).toBeNull()
	})
})

describe("statementSpansInput", () => {
	test("reads the matched shapes' spans in the instance's databases over the window", () => {
		const peek = resolveQueryPeek(rows, new Map([["a", traced(["checkout-api"], 1)]]), ["orders"], "a")
		expect(peek === null ? null : statementSpansInput(peek, window)).toEqual({
			...window,
			databases: ["orders"],
			queryKeys: ["1449", "2077"],
		})
	})

	test("asks nothing for a statement the traces never recorded, or without databases", () => {
		const untraced = resolveQueryPeek(rows, new Map(), ["orders"], "a")
		const noDatabases = resolveQueryPeek(rows, new Map([["a", traced(["checkout-api"], 1)]]), [], "a")
		expect(untraced === null ? "none" : statementSpansInput(untraced, window)).toBeNull()
		expect(noDatabases === null ? "none" : statementSpansInput(noDatabases, window)).toBeNull()
	})
})

describe("statementTracesHref", () => {
	test("narrows Traces to every caller and the statement's text up to its first placeholder", () => {
		const peek = resolveQueryPeek(rows, new Map([["a", traced(["checkout-api"], 1)]]), [], "a")
		const search = searchOf(peek === null ? "" : statementTracesHref(peek, { timePreset: "6h" }))
		expect(search.get("timePreset")).toBe("6h")
		expect(search.get("services")).toContain("checkout-api")
		expect(search.get("attributeFilters")).toContain("SELECT id, status FROM orders WHERE org_id =")
	})

	test("leaves services open when only the busiest callers are known", () => {
		const peek = resolveQueryPeek(rows, new Map([["a", traced(["checkout-api"], 3)]]), [], "a")
		expect(searchOf(peek === null ? "" : statementTracesHref(peek, {})).has("services")).toBe(false)
	})

	test("drops the text filter when too little precedes the placeholder", () => {
		const peek = resolveQueryPeek(rows, new Map([["b", traced(["checkout-api"], 1)]]), [], "b")
		expect(searchOf(peek === null ? "" : statementTracesHref(peek, {})).has("attributeFilters")).toBe(
			false,
		)
	})
})
