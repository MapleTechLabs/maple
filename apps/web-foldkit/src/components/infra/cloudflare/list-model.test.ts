import { describe, expect, it } from "vitest"

import type {
	CloudflareDurableObjectRow,
	CloudflareWorkerRow,
	CloudflareZoneRow,
} from "@maple/web-data/warehouse/cloudflare-infra"
import { mergeWorkerRows, sortWorkersByAttention, workerHealth, zoneHealth } from "./list-model"

const zone = (requests: number, errorRate: number, clientErrorRate: number): CloudflareZoneRow => ({
	serviceName: "cloudflare/z",
	zoneName: "z",
	requests,
	errors5xx: Math.round(requests * errorRate),
	errorRate,
	errors4xx: Math.round(requests * clientErrorRate),
	clientErrorRate,
	requests2xx: 0,
	requests3xx: 0,
	cacheHits: 0,
	cacheableRequests: 0,
	cacheHitRate: null,
	bytes: 0,
	visits: 0,
	ttfbP50Ms: 0,
	ttfbP95Ms: 0,
	ttfbP99Ms: 0,
	originP50Ms: 0,
	originP95Ms: 0,
	originP99Ms: 0,
})

const worker = (
	scriptName: string,
	requests: number,
	errorRate: number,
	durationP99Ms = 50,
	accountId = "acct-prod",
): CloudflareWorkerRow => ({
	serviceName: `cloudflare-worker/${scriptName}`,
	accountId,
	scriptName,
	requests,
	errors: Math.round(requests * errorRate),
	errorRate,
	subrequests: 0,
	cpuP50Ms: 1,
	cpuP99Ms: 2,
	durationP50Ms: 10,
	durationP99Ms,
})

const durable = (
	scriptName: string,
	requests: number,
	errorRate: number,
	accountId = "acct-prod",
): CloudflareDurableObjectRow => ({
	serviceName: `cloudflare-worker/${scriptName}`,
	accountId,
	scriptName,
	requests,
	errors: Math.round(requests * errorRate),
	errorRate,
})

describe("zoneHealth", () => {
	it("doesn't rate a zone too small to rate", () => {
		expect(zoneHealth(zone(15, 0.07, 0))).toBe("lowVolume")
	})

	it("calls out a zone that is mostly 4xx even with no 5xx", () => {
		expect(zoneHealth(zone(150_000_000, 0, 0.94))).toBe("mostly4xx")
	})

	it("ranks serving 5xx above mostly 4xx", () => {
		expect(zoneHealth(zone(90_000, 0.25, 0.6))).toBe("serving5xx")
	})
})

describe("mergeWorkerRows", () => {
	it("folds a failing Durable Object onto its Worker and marks the Worker erroring", () => {
		const [row] = mergeWorkerRows([worker("hazel-api", 1764, 0)], [durable("hazel-api", 1457, 0.999)])
		expect(row?.doRequests).toBe(1457)
		expect(row && workerHealth(row)).toBe("erroring")
	})

	it("keeps scripts that only host Durable Objects", () => {
		const rows = mergeWorkerRows([], [durable("maple-sandbox", 208, 0)])
		expect(rows.map((r) => [r.scriptName, r.requests, r.doRequests])).toEqual([["maple-sandbox", 0, 208]])
	})

	it("keeps same-named Workers in two accounts apart and says so", () => {
		const rows = mergeWorkerRows(
			[
				worker("api-gateway", 4_800_000, 0, 88, "acct-prod"),
				worker("api-gateway", 120_000, 0.042, 340, "acct-staging"),
			],
			[durable("api-gateway", 900, 0.5, "acct-staging")],
		)
		expect(rows.map((r) => [r.accountId, r.requests, r.doRequests, r.nameInOtherAccounts])).toEqual([
			["acct-prod", 4_800_000, 0, true],
			["acct-staging", 120_000, 900, true],
		])
	})

	it("flags per-PR preview deploys", () => {
		const rows = mergeWorkerRows([worker("maple-api-pr-1336", 16, 0), worker("maple-api", 15_820, 0)], [])
		expect(rows.map((r) => r.isPreview)).toEqual([true, false])
	})
})

describe("sortWorkersByAttention", () => {
	it("orders erroring Workers by how badly they fail, not by volume", () => {
		const rows = mergeWorkerRows(
			[worker("maple-api", 15_820, 0.011), worker("hazel-backend", 159, 1)],
			[],
		)
		expect(sortWorkersByAttention(rows).map((r) => r.scriptName)).toEqual(["hazel-backend", "maple-api"])
	})

	it("puts a small failing Worker above a busy healthy one", () => {
		const rows = mergeWorkerRows(
			[
				worker("maple-api", 15_820, 0),
				worker("maple-alerting", 955, 0, 5835),
				worker("hazel-backend", 159, 1),
			],
			[],
		)
		expect(sortWorkersByAttention(rows).map((r) => r.scriptName)).toEqual([
			"hazel-backend",
			"maple-alerting",
			"maple-api",
		])
	})
})
