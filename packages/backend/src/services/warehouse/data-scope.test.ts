import { isDatasourceDefinition } from "@maple-dev/effect-orm/tinybird"
import * as Datasources from "@maple/domain/tinybird"
import { collectQueryCatalog } from "@maple/query-engine/benchmark"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { rowFilterFor, SCOPED_DATASOURCES } from "./data-scope"
import { withoutStringLiterals } from "./warehouse-catalog"

const datasources = new Map(
	Arr.map(Arr.filter(Rec.values(Datasources), isDatasourceDefinition), (datasource) => [
		datasource._name,
		Rec.keys(datasource._schema),
	]),
)

const REQUIRED_COLUMN = {
	namespace: "ServiceNamespace",
	resource: "ResourceAttributes",
	locator: "TraceId",
} as const

describe("datasources a namespace-limited role may read", () => {
	// A filter on a column a datasource lacks fails every read of it; a datasource without OrgId is
	// in no org token at all.
	it("each has the column its filter is written on, and an org column", () => {
		const broken = Arr.flatMap(Arr.fromIterable(SCOPED_DATASOURCES), ([name, kind]) => {
			const columns = datasources.get(name)
			if (columns === undefined) return [`${name} is not a datasource`]
			return [
				...(columns.includes(REQUIRED_COLUMN[kind])
					? []
					: [`${name} has no ${REQUIRED_COLUMN[kind]}`]),
				...(columns.includes("OrgId") ? [] : [`${name} has no OrgId`]),
			]
		})
		expect(broken).toEqual([])
	})

	it("every one that has a namespace column is filtered on it", () => {
		const loose = Arr.filter(
			Arr.fromIterable(SCOPED_DATASOURCES),
			([name, kind]) =>
				kind !== "namespace" && (datasources.get(name) ?? []).includes("ServiceNamespace"),
		)
		expect(loose).toEqual([])
	})

	// A locator is not filtered by namespace, so nothing it holds may become an answer: every
	// compiled read of one either feeds a seek into another table or returns a trace's times only.
	it("no compiled query answers with a locator's rows", () => {
		const locators = Arr.flatMap(Arr.fromIterable(SCOPED_DATASOURCES), ([name, kind]) =>
			kind === "locator" ? [name] : [],
		)
		const timesOnly =
			/^(?:\s*(?:[a-z_]+\.TraceId AS traceId|min\([a-z_]+\.MinTimestamp\) AS timestamp|max\([a-z_]+\.MaxTimestamp\) AS endTimestamp),?)+\s*$/
		// Each innermost SELECT of the catalog that reads a locator: whether it feeds a seek, and what it selects.
		const reads = Arr.flatMap(Effect.runSync(collectQueryCatalog), (entry) =>
			Arr.flatMap(locators, (locator) =>
				Arr.map(
					Arr.fromIterable(
						Str.matchAll(
							new RegExp(`(IN \\()?SELECT((?:(?!SELECT)[\\s\\S])*?)FROM ${locator}\\b`, "g"),
						)(entry.sql),
					),
					([, seek, selected]) => ({
						query: `${entry.source}:${entry.name}`,
						isSeek: seek !== undefined,
						selected: selected ?? "",
					}),
				),
			),
		)
		const answering = Arr.filter(reads, (read) => !read.isSeek && !timesOnly.test(read.selected))
		// Both shapes exist today; with neither found, the patterns above have stopped matching.
		expect(Arr.some(reads, (read) => read.isSeek)).toBe(true)
		expect(Arr.some(reads, (read) => !read.isSeek)).toBe(true)
		expect(
			Arr.dedupe(Arr.map(answering, (read) => `${read.query} selects ${Str.trim(read.selected)}`)),
		).toEqual([])
	})
})

describe("rowFilterFor", () => {
	it("has no filter for a datasource that is not listed, or that only names a service", () => {
		for (const datasource of [
			"session_replay_events",
			"error_events",
			"metric_catalog",
			"not_a_datasource",
		]) {
			expect(rowFilterFor(datasource, ["checkout"], "compiled")).toEqual(Option.none())
		}
	})

	it("filters on the datasource's own namespace", () => {
		expect(rowFilterFor("trace_list_mv", ["checkout", "payments"], "compiled")).toEqual(
			Option.some("ServiceNamespace IN ('checkout', 'payments')"),
		)
		expect(rowFilterFor("traces", ["checkout"], "caller-sql")).toEqual(
			Option.some("ResourceAttributes['service.namespace'] IN ('checkout')"),
		)
	})

	it("matches no row for no namespace instead of writing an empty IN", () => {
		expect(rowFilterFor("trace_list_mv", [], "compiled")).toEqual(Option.some("1 = 0"))
		expect(rowFilterFor("logs", [], "caller-sql")).toEqual(Option.some("1 = 0"))
	})

	it("writes no value that could end the string it is quoted in", () => {
		const hostile = ["ok", "it's", "back\\slash", "semi;colon", "new\nline", "paren)", "back`tick"]
		expect(rowFilterFor("logs", hostile, "compiled")).toEqual(
			Option.some("ResourceAttributes['service.namespace'] IN ('ok')"),
		)
		expect(rowFilterFor("logs", ["it's"], "compiled")).toEqual(Option.some("1 = 0"))
	})

	it("lets a query Maple compiled seek through a locator, and leaves it out of caller SQL", () => {
		expect(rowFilterFor("trace_index", ["checkout"], "compiled")).toEqual(Option.some("1 = 1"))
		expect(rowFilterFor("trace_index", ["checkout"], "caller-sql")).toEqual(Option.none())
	})
})

describe("withoutStringLiterals", () => {
	it("empties literals, escaped quotes included, and leaves the statement around them", () => {
		expect(
			withoutStringLiterals(
				"SELECT 1 FROM logs WHERE Body ILIKE '%audit_log%' AND a = 'it\\'s' AND b = 'x''y'",
			),
		).toBe("SELECT 1 FROM logs WHERE Body ILIKE '' AND a = '' AND b = ''")
	})
})
