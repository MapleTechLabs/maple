import { Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import {
	commitsKey,
	healthSummary,
	perSecondRates,
	releaseLabeler,
	releaseOptions,
	serviceHealthRowKey,
} from "./derive"
import type { ServiceRow } from "./model"
import type { HealthIncident } from "../../kit/service-health"

const service = (serviceName: string): ServiceRow => ({
	serviceName,
	serviceNamespace: "",
	environment: "production",
	commits: [],
	p50LatencyMs: 10,
	p95LatencyMs: 20,
	p99LatencyMs: 30,
	errorRate: 0,
	throughput: 1,
	tracedThroughput: 1,
	hasSampling: false,
	samplingWeight: 1,
	spanCount: 10,
})

const incident = (groupKey: string, signalType: HealthIncident["signalType"]): HealthIncident => ({
	ruleId: `rule-${groupKey}`,
	ruleName: `${groupKey} errors`,
	status: "open",
	groupKey,
	severity: "critical",
	signalType,
})

describe("healthSummary", () => {
	it("marks a service unhealthy while its uptime check or an alert rule is firing", () => {
		const summary = healthSummary(
			[service("checkout-api"), service("payments"), service("search")],
			[incident("checkout-api", "uptime"), incident("payments", "error_rate")],
			[],
			Date.parse("2026-10-26T00:00:00Z"),
		)
		const health = (name: string) => summary.byRow.get(serviceHealthRowKey(name, "production"))
		expect([health("checkout-api"), health("payments"), health("search")]).toEqual([
			"unhealthy",
			"unhealthy",
			"healthy",
		])
		expect(summary.counts).toEqual({ healthy: 1, degraded: 0, unhealthy: 2 })
	})
})

describe("perSecondRates", () => {
	const window = {
		startMs: Date.parse("2026-10-01T00:00:00Z"),
		endMs: Date.parse("2026-10-01T00:02:30Z"),
		bucketSeconds: 60,
	}

	it("divides each full bucket's count by the bucket length", () => {
		const rates = perSecondRates(
			[
				{ bucket: "2026-10-01 00:00:00", throughput: 120 },
				{ bucket: "2026-10-01 00:01:00", throughput: 30 },
			],
			window,
		)
		expect(rates).toEqual([2, 0.5])
	})

	it("reads the bucket the window ends inside over the seconds it covers", () => {
		// 00:02:00 to 00:02:30 is 30 seconds of a 60-second bucket.
		const [rate] = perSecondRates([{ bucket: "2026-10-01 00:02:00", throughput: 30 }], window)
		expect(rate).toBe(1)
	})

	it("a window ending exactly on a bucket edge leaves the last bucket whole", () => {
		const [rate] = perSecondRates([{ bucket: "2026-10-01 00:01:00", throughput: 60 }], {
			...window,
			endMs: Date.parse("2026-10-01T00:02:00Z"),
		})
		expect(rate).toBe(1)
	})

	it("a bucket outside the window reads zero rather than dividing by nothing", () => {
		const [rate] = perSecondRates([{ bucket: "2026-10-01 00:05:00", throughput: 10 }], window)
		expect(rate).toBe(0)
	})
})

const sha = (c: string) => Str.repeat(40)(c)
const deployed = (name: string, commitSha: string): ServiceRow => ({
	...service(name),
	commits: [{ commitSha, spanCount: 10, percentage: 100, errorCount: 0, firstSeen: "2026-10-01 00:00:00" }],
})

describe("commitsKey", () => {
	it("asks for the deploy commits first, then the facet's, in one deduped batch", () => {
		expect(
			commitsKey(
				[deployed("api", sha("f")), deployed("web", sha("b"))],
				[sha("a"), sha("b"), "v1.2.3"],
			),
		).toBe(`${sha("b")},${sha("f")},${sha("a")}`)
	})

	it("keeps the deploy commits when the facet would push the batch past 50", () => {
		const facet = Arr.makeBy(60, (i) => Str.padStart(40, "0")(i.toString(16)))
		const key = Str.split(",")(commitsKey([deployed("api", sha("f"))], facet))
		expect(key).toHaveLength(50)
		expect(key).toContain(sha("f"))
	})
})

describe("release facet", () => {
	const summaries = {
		[sha("a")]: { subject: "fix: older", committedAt: 1000 },
		[sha("b")]: { subject: "feat: newer", committedAt: 2000 },
	}

	it("lists resolved commits newest first, then the unresolved ones in span-count order", () => {
		const options = [
			{ name: sha("c"), count: 900 },
			{ name: sha("a"), count: 500 },
			{ name: sha("d"), count: 100 },
			{ name: sha("b"), count: 50 },
		]
		expect(Arr.map(releaseOptions(options, summaries), (o) => o.name)).toEqual([
			sha("b"),
			sha("a"),
			sha("c"),
			sha("d"),
		])
	})

	it("labels a row by its commit subject, or its short sha until the commit resolves", () => {
		const label = releaseLabeler(summaries)
		expect(label(sha("b"))).toBe("feat: newer")
		expect(label(sha("c"))).toBe("ccccccc")
		expect(label("release-42")).toBe("release-42")
	})

	it("adds the short sha when two commits share a subject", () => {
		const label = releaseLabeler({
			[sha("a")]: { subject: "chore: bump deps", committedAt: 1000 },
			[sha("b")]: { subject: "chore: bump deps", committedAt: 2000 },
			[sha("c")]: { subject: "feat: unique", committedAt: 3000 },
		})
		expect(Arr.map([sha("a"), sha("b"), sha("c")], label)).toEqual([
			"chore: bump deps · aaaaaaa",
			"chore: bump deps · bbbbbbb",
			"feat: unique",
		])
	})
})
