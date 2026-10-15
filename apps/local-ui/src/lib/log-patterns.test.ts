import { describe, expect, it } from "vitest"
import { clusterLogPatterns } from "@maple/query-engine/observability"
import { patternSearchTerm, rankCounts, severityBreakdown, splitTemplate } from "./log-patterns"

describe("splitTemplate", () => {
	it("separates literal runs from wildcard and named variables", () => {
		expect(splitTemplate("user <*> logged in from <ip>")).toEqual([
			{ text: "user ", variable: false },
			{ text: "<*>", variable: true },
			{ text: " logged in from ", variable: false },
			{ text: "<ip>", variable: true },
		])
	})

	it("keeps a template with no variables whole", () => {
		expect(splitTemplate("server started")).toEqual([{ text: "server started", variable: false }])
	})

	it("leaves angle-bracketed text that is not a mask as a literal", () => {
		expect(splitTemplate("<html> <*>")).toEqual([
			{ text: "<html> ", variable: false },
			{ text: "<*>", variable: true },
		])
	})
})

describe("patternSearchTerm", () => {
	it("picks the longest single literal token", () => {
		expect(patternSearchTerm("user <*> logged in from <ip>")).toBe("logged")
	})

	it("stays a substring of bodies whose whitespace Drain collapsed", () => {
		const rows = [
			{ body: "payment   declined for order 1", severityText: "WARN", serviceName: "api" },
			{ body: "payment\tdeclined for order 2", severityText: "WARN", serviceName: "api" },
		]
		const { patterns } = clusterLogPatterns(rows)
		const term = patternSearchTerm(patterns[0].template)
		expect(term.length).toBeGreaterThan(0)
		for (const row of rows) expect(row.body).toContain(term)
	})

	it("is empty for an all-variable template", () => {
		expect(patternSearchTerm("<*> <*>")).toBe("")
	})

	it("matches the sample bodies of a mined pattern", () => {
		const rows = [
			{ body: "request 1 took 20ms", severityText: "INFO", serviceName: "api" },
			{ body: "request 2 took 35ms", severityText: "INFO", serviceName: "api" },
			{ body: "request 3 took 40ms", severityText: "WARN", serviceName: "web" },
		]
		const { patterns } = clusterLogPatterns(rows)
		const term = patternSearchTerm(patterns[0].template)
		expect(term.length).toBeGreaterThan(0)
		for (const row of rows) expect(row.body).toContain(term)
	})
})

describe("rankCounts", () => {
	it("orders by count, then name", () => {
		expect(rankCounts({ web: 2, api: 5, auth: 2 }).map((e) => e.name)).toEqual(["api", "auth", "web"])
	})
})

describe("severityBreakdown", () => {
	it("orders by level, most severe first", () => {
		expect(severityBreakdown({ INFO: 10, ERROR: 1, WARN: 3 }).map((e) => e.name)).toEqual([
			"ERROR",
			"WARN",
			"INFO",
		])
	})
})
