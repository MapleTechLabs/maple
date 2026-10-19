import { describe, expect, it } from "vitest"
import { VercelProjectStatus, type VercelInfraProject } from "@maple/domain/http"

import { decodeLogAttributeFilters } from "@/lib/logs/log-attribute-filters"
import { parseWhereClause } from "@/lib/traces/advanced-filter-sync"

import {
	aiGatewayProjectLabel,
	fillBuckets,
	requestClassRows,
	vercelFleetTotals,
	vercelProjectLogAttrs,
	vercelProjectRow,
	vercelProjectRows,
	vercelProjectTracesWhere,
	zeroRequestBucket,
} from "./list-model"

const project = (id: string, name: string, forwarded = true) =>
	new VercelProjectStatus({
		id,
		name,
		framework: "nextjs",
		forwarded,
		productionDeployment: null,
		latestDeployment: null,
	})

const row = (projectId: string, patch: Partial<VercelInfraProject> = {}): VercelInfraProject => ({
	projectId,
	projectName: projectId,
	serviceName: projectId,
	requests: 100,
	requests4xx: 0,
	requests5xx: 0,
	cacheHits: 0,
	cacheLookups: 0,
	errorLogs: 0,
	lastSeen: "2026-10-19T12:00:00Z",
	p50DurationMs: null,
	p95DurationMs: null,
	...patch,
})

describe("vercelProjectRows", () => {
	it("lists forwarded projects without data, drops unforwarded ones without data, busiest first", () => {
		const rows = vercelProjectRows(
			[project("p1", "web"), project("p2", "docs"), project("p3", "legacy", false)],
			[row("p2", { requests: 500 })],
		)
		expect(rows.map((r) => [r.name, r.requests, r.errorPercent, r.lastSeen])).toEqual([
			["docs", 500, 0, "2026-10-19T12:00:00Z"],
			["web", 0, null, null],
		])
	})

	it("keeps a project that delivered data but is missing from the inventory", () => {
		const rows = vercelProjectRows([], [row("prj_9", { projectName: "" })])
		expect(rows.map((r) => [r.projectId, r.name, r.framework])).toEqual([["prj_9", "prj_9", null]])
	})

	it("reads cache hits against lookups, not against every request", () => {
		const [first] = vercelProjectRows(
			[project("p1", "web")],
			[row("p1", { requests: 1000, cacheHits: 30, cacheLookups: 40, requests5xx: 50 })],
		)
		expect(first?.cacheHitPercent).toBe(75)
		expect(first?.errorPercent).toBe(5)
	})
})

describe("vercelProjectRow", () => {
	it("gives a project with nothing in the window zeros under its inventory name", () => {
		const one = vercelProjectRow("p1", [project("p1", "web")], [row("p2")])
		expect([one.name, one.requests, one.errorPercent, one.p95DurationMs]).toEqual(["web", 0, null, null])
	})

	it("falls back to the drain's name, then the id, when the inventory does not list it", () => {
		expect(vercelProjectRow("p2", [], [row("p2", { projectName: "docs" })]).name).toBe("docs")
		expect(vercelProjectRow("p3", [], []).name).toBe("p3")
	})
})

describe("vercelFleetTotals", () => {
	it("sums the fleet and has no cache rate when nothing was looked up", () => {
		expect(
			vercelFleetTotals([
				row("a", { requests: 300, requests5xx: 3, errorLogs: 2 }),
				row("b", { requests: 100, requests5xx: 1, errorLogs: 5 }),
			]),
		).toEqual({ requests: 400, requests5xx: 4, errorPercent: 1, cacheHitPercent: null, errorLogs: 7 })
	})
})

describe("fillBuckets", () => {
	const window = { startTime: "2026-10-19 12:00:00", endTime: "2026-10-19 12:20:00", bucketSeconds: 300 }

	it("fills the window's grid with zeros around the buckets the warehouse returned", () => {
		const filled = fillBuckets(
			[{ ...zeroRequestBucket("2026-10-19T12:05:00.000000Z"), requests: 7 }],
			window,
			zeroRequestBucket,
		)
		expect(filled.map((b) => [b.bucket, b.requests])).toEqual([
			["2026-10-19T12:00:00.000Z", 0],
			["2026-10-19T12:05:00.000Z", 7],
			["2026-10-19T12:10:00.000Z", 0],
			["2026-10-19T12:15:00.000Z", 0],
		])
	})

	it("leaves an empty series empty", () => {
		expect(fillBuckets([], window, zeroRequestBucket)).toEqual([])
	})
})

describe("requestClassRows", () => {
	it("stacks requests without a status as unknown so the classes total every request", () => {
		const rows = requestClassRows([
			{
				...zeroRequestBucket("2026-10-19T12:00:00.000Z"),
				requests: 10,
				requests2xx: 6,
				requests5xx: 1,
			},
		])
		expect(rows.reduce((sum, r) => sum + r.value, 0)).toBe(10)
		expect(rows.find((r) => r.attributeValue === "unknown")?.value).toBe(3)
	})
})

describe("aiGatewayProjectLabel", () => {
	const names = new Map([["prj_1", "storefront"]])

	it("names a project from the inventory and falls back to its id", () => {
		expect(aiGatewayProjectLabel("prj_1", names)).toBe("storefront")
		expect(aiGatewayProjectLabel("prj_2", names)).toBe("prj_2")
	})

	it("says when a request was made outside any project", () => {
		expect(aiGatewayProjectLabel("", names)).toBe("Outside a project")
	})
})

describe("explorer filters", () => {
	it("filters logs on the drain's project resource attribute", () => {
		expect(decodeLogAttributeFilters([...vercelProjectLogAttrs("prj_1")])).toEqual([
			{ source: "resource", key: "vercel.project.id", value: "prj_1", negated: false },
		])
	})

	it("filters traces on the resource attribute Vercel sets", () => {
		expect(parseWhereClause(vercelProjectTracesWhere("prj_1")).filters.resourceAttributeFilters).toEqual([
			expect.objectContaining({ key: "vercel.projectId", value: "prj_1" }),
		])
	})
})
