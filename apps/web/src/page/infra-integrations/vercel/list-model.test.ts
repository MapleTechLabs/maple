import { describe, expect, it } from "vitest"
import { Array as Arr, Option } from "effect"
import { VercelDeploymentSummary, VercelProjectStatus, type VercelInfraProject } from "@maple/domain/http"

import { decodeLogAttributeFilters } from "@maple/views/lib/log-attribute-filters"
import { parseWhereClause } from "@/page/traces/advanced-filter-sync"

import {
	aiGatewayProjectLabel,
	buildDurationMs,
	fillBuckets,
	isFailedBuild,
	vercelBuildLogAttrs,
	vitalRating,
	vitalsByKey,
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
	invocations: 0,
	coldStarts: 0,
	...patch,
})

describe("vercelProjectRows", () => {
	it("lists forwarded projects without data, drops unforwarded ones without data, busiest first", () => {
		const rows = vercelProjectRows(
			[project("p1", "web"), project("p2", "docs"), project("p3", "legacy", false)],
			[row("p2", { requests: 500 })],
		)
		expect(Arr.map(rows, (r) => [r.name, r.requests, r.errorPercent, r.lastSeen])).toEqual([
			["docs", 500, 0, "2026-10-19T12:00:00Z"],
			["web", 0, null, null],
		])
	})

	it("names a project that only sends traces from the inventory, with latency and no rates", () => {
		const rows = vercelProjectRows(
			[project("p1", "web")],
			[row("p1", { projectName: "", requests: 0, p95DurationMs: 120 })],
		)
		expect(Arr.map(rows, (r) => [r.name, r.p95DurationMs, r.errorPercent, r.cacheHitPercent])).toEqual([
			["web", 120, null, null],
		])
	})

	it("keeps a project that delivered data but is missing from the inventory", () => {
		const rows = vercelProjectRows([], [row("prj_9", { projectName: "" })])
		expect(Arr.map(rows, (r) => [r.projectId, r.name, r.framework])).toEqual([["prj_9", "prj_9", null]])
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
		).toMatchObject({
			requests: 400,
			requests5xx: 4,
			errorPercent: 1,
			cacheHitPercent: null,
			errorLogs: 7,
		})
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
		expect(Arr.map(filled, (b) => [b.bucket, b.requests])).toEqual([
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
		expect(Arr.reduce(rows, 0, (sum, r) => sum + r.value)).toBe(10)
		expect(
			Option.map(
				Arr.findFirst(rows, (r) => r.attributeValue === "unknown"),
				(r) => r.value,
			),
		).toEqual(Option.some(3))
	})
})

describe("aiGatewayProjectLabel", () => {
	const names = new Map([["prj_1", "storefront"]])

	it("names a project from the inventory and falls back to its id", () => {
		expect(aiGatewayProjectLabel("prj_1", names)).toBe("storefront")
		expect(aiGatewayProjectLabel("prj_2", names)).toBe("prj_2")
	})

	it("says when a request was made outside any project", () => {
		expect(aiGatewayProjectLabel("", names)).toBe("No project")
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

describe("cold starts", () => {
	it("rates cold starts per project and across the team, none without invocations", () => {
		const rows = vercelProjectRows(
			[project("p1", "web"), project("p2", "docs")],
			[row("p1", { invocations: 200, coldStarts: 10 }), row("p2")],
		)
		expect(Arr.map(rows, (r) => [r.name, r.coldStartPercent])).toEqual([
			["docs", null],
			["web", 5],
		])
		const totals = vercelFleetTotals([
			row("p1", { invocations: 200, coldStarts: 10 }),
			row("p2", { invocations: 50, coldStarts: 15 }),
		])
		expect(totals.coldStartPercent).toBe(10)
	})
})

const deployment = (patch: Partial<VercelDeploymentSummary> = {}) =>
	new VercelDeploymentSummary({
		id: "dpl_1",
		projectId: "p1",
		url: "web-abc.vercel.app",
		target: "production",
		state: "READY",
		branch: "main",
		commitSha: null,
		commitMessage: null,
		creator: null,
		createdAt: 1_000,
		buildingAt: 5_000,
		readyAt: 95_000,
		errorCode: null,
		errorMessage: null,
		inspectorUrl: null,
		...patch,
	})

describe("builds", () => {
	it("times a build from its start to ready, and not while it builds", () => {
		expect(buildDurationMs(deployment())).toBe(90_000)
		expect(buildDurationMs(deployment({ state: "BUILDING", readyAt: null }))).toBeNull()
	})

	it("counts errored and canceled builds as failed", () => {
		expect(
			Arr.map(["READY", "ERROR", "CANCELED", "BUILDING"], (state) =>
				isFailedBuild(deployment({ state })),
			),
		).toEqual([false, true, true, false])
	})

	it("filters logs on one deployment's build output", () => {
		expect(decodeLogAttributeFilters([...vercelBuildLogAttrs("dpl_1")])).toEqual([
			{ source: "resource", key: "vercel.deployment.id", value: "dpl_1", negated: false },
			{ source: "log", key: "vercel.source", value: "build", negated: false },
		])
	})
})

describe("Web Vitals", () => {
	it("rates a p75 against web.dev's thresholds", () => {
		expect([vitalRating("LCP", 2400), vitalRating("LCP", 3200), vitalRating("LCP", 4100)]).toEqual([
			"good",
			"needsImprovement",
			"poor",
		])
		expect(vitalRating("CLS", 0.3)).toBe("poor")
	})

	it("pivots readings into one row per route, the most sampled first, ignoring unknown metrics", () => {
		const rows = vitalsByKey([
			{ key: "/blog", metric: "LCP", p75: 1800, samples: 40 },
			{ key: "/", metric: "LCP", p75: 2600, samples: 300 },
			{ key: "/", metric: "INP", p75: 120, samples: 280 },
			{ key: "/", metric: "FID", p75: 10, samples: 900 },
		])
		expect(rows).toEqual([
			{ key: "/", samples: 300, p75: { LCP: 2600, INP: 120 } },
			{ key: "/blog", samples: 40, p75: { LCP: 1800 } },
		])
	})
})
