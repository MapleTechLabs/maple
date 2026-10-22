import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { asCacheValue, hashKey, parseSaved, serialize } from "../../data/cache-store"
import { type LocalServiceMapData, mapFromCached } from "./data"

const data: LocalServiceMapData = {
	edges: [
		{
			sourceService: "storefront",
			targetService: "checkout-api",
			callCount: 30,
			estimatedCallCount: 30,
			errorCount: 1,
			errorRate: 1 / 30,
			avgDurationMs: 12,
			maxDurationMs: 40,
			hasSampling: false,
			samplingWeight: 1,
		},
	],
	dbEdges: [],
	overviews: [
		{
			serviceName: "storefront",
			serviceNamespace: "shop",
			environment: "production",
			commits: [{ commitSha: "abc", spanCount: 3, percentage: 100, errorCount: 0, firstSeen: "" }],
			p50LatencyMs: 10,
			p95LatencyMs: 20,
			p99LatencyMs: 30,
			errorRate: 0,
			throughput: 1,
			tracedThroughput: 1,
			hasSampling: false,
			samplingWeight: 1,
			spanCount: 3,
		},
	],
	platforms: new Map([["storefront", "web"]]),
	runtimes: new Map([["storefront", "nodejs"]]),
}

describe("service map result cache", () => {
	test("a recorded map reads back as the same rows", () => {
		const restored = Option.flatMap(asCacheValue(data), mapFromCached)
		expect(restored).toEqual(Option.some(data))
	})

	test("a saved map survives a reload", () => {
		const key = ["local", "service-map", 3600, "2026-10-01 11:00:00/2026-10-01 13:00:00"]
		const entry = { key, data: Option.getOrThrow(asCacheValue(data)), updatedAtMs: 1_000 }
		const restored = parseSaved(serialize(new Map([[hashKey(key), entry]])), 2_000).get(hashKey(key))
		expect(Option.flatMap(Option.fromNullishOr(restored), (saved) => mapFromCached(saved.data))).toEqual(
			Option.some(data),
		)
	})

	test("an older build's shape is not offered as the map", () => {
		const olderBuildEntry = Option.flatMap(
			asCacheValue({ ...data, platforms: { storefront: "web" } }),
			mapFromCached,
		)
		expect(Option.isNone(olderBuildEntry)).toBe(true)
	})
})
