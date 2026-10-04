import { describe, expect, it } from "vitest"

import type { CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import type { PlanetScaleDatabaseStat } from "@/api/warehouse/service-map"

import type { HostRow } from "../host-table"
import { summarizeCloudflare, summarizeHosts, summarizePlanetScale, summarizePods } from "./summaries"

const END = "2026-10-04T12:00:00Z"

const host = (hostName: string, cpuPct: number, lastSeen = END): HostRow => ({
	hostName,
	osType: "linux",
	hostArch: "amd64",
	cloudProvider: "aws",
	lastSeen,
	cpuPct,
	memoryPct: 0.2,
	diskPct: 0.1,
	load15: 1,
})

const zone = (zoneName: string, requests: number, errorRate: number): CloudflareZoneRow => ({
	serviceName: `cloudflare/${zoneName}`,
	zoneName,
	requests,
	errors5xx: Math.round(requests * errorRate),
	errorRate,
	cacheHits: requests / 2,
	cacheHitRate: 0.5,
	bytes: 0,
	visits: 0,
	ttfbP50Ms: 0,
	ttfbP95Ms: 0,
	ttfbP99Ms: 0,
	originP50Ms: 0,
	originP95Ms: 0,
	originP99Ms: 900,
})

const db = (
	database: string,
	replicaLagMaxSeconds: number,
	storageUsedPercent: number | null,
): PlanetScaleDatabaseStat => ({
	database,
	connectionsAvg: 0,
	connectionsMax: 0,
	cpuMaxPercent: 0,
	memMaxPercent: 0,
	replicaLagMaxSeconds,
	storageUsedPercent,
})

describe("summarizeHosts", () => {
	it("lists saturated hosts busiest first and folds the rest into one line", () => {
		const hosts = [0.95, 0.99, 0.91, 0.92, 0.3].map((cpu, i) => host(`h${i}`, cpu))
		const { findings, segments } = summarizeHosts(hosts, END)
		expect(findings.map((f) => f.title)).toEqual([
			"h1 at 99% CPU",
			"h0 at 95% CPU",
			"h3 at 92% CPU",
			"1 more host at 90% or above",
		])
		expect(segments.find((s) => s.key === "saturated")?.count).toBe(4)
	})

	it("reports hosts that stopped reporting as one stale finding", () => {
		const { findings } = summarizeHosts([host("old", 0.1, "2026-10-04T10:00:00Z")], END)
		expect(findings).toEqual([
			expect.objectContaining({ tone: "stale", title: "1 host stopped reporting" }),
		])
	})
})

describe("summarizeCloudflare", () => {
	it("ignores error rates on zones too quiet to mean anything", () => {
		const { findings } = summarizeCloudflare([
			zone("quiet.dev", 20, 0.5),
			zone("api.acme.dev", 10_000, 0.06),
		])
		expect(findings.map((f) => f.title)).toEqual(["api.acme.dev returning 6.0% 5xx"])
		expect(findings[0]?.tone).toBe("crit")
	})
})

describe("summarizePlanetScale", () => {
	it("flags lag and storage separately and puts critical findings first", () => {
		const { findings } = summarizePlanetScale([db("ledger", 2, 85), db("users", 0.1, null)])
		expect(findings.map((f) => [f.tone, f.title])).toEqual([
			["crit", "ledger storage at 85%"],
			["warn", "ledger replica 2.0s behind primary"],
		])
	})
})

describe("summarizePods", () => {
	it("says nothing about a fleet with no saturated or unbounded pods", () => {
		const summary = summarizePods({
			livePods: 40,
			endedPods: 3,
			saturatedPods: 0,
			elevatedPods: 2,
			unboundedPods: 0,
		})
		expect(summary.findings).toEqual([])
		expect(summary.headline).toBe("no pod at its limit")
	})
})
