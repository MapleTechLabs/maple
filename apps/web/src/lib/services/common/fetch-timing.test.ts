import { describe, expect, it } from "vitest"

import { type ResourceTimingPhases, resourceEntryName, resourceTimingAttributes } from "./fetch-timing"

const coldEntry: ResourceTimingPhases = {
	startTime: 100,
	duration: 400,
	domainLookupStart: 110,
	domainLookupEnd: 130,
	connectStart: 130,
	secureConnectionStart: 160,
	connectEnd: 210,
	requestStart: 215,
	responseStart: 455,
	responseEnd: 500,
	nextHopProtocol: "h2",
	encodedBodySize: 1234,
}

describe("resourceTimingAttributes", () => {
	it("splits a cold call into its network phases", () => {
		expect(resourceTimingAttributes(coldEntry, 12.34)).toEqual({
			"maple.fetch.total_ms": 400,
			"maple.auth.wait_ms": 12.3,
			"maple.fetch.timing_allowed": true,
			"maple.fetch.dns_ms": 20,
			"maple.fetch.connect_ms": 30,
			"maple.fetch.tls_ms": 50,
			"maple.fetch.stalled_ms": 15,
			"maple.fetch.ttfb_ms": 240,
			"maple.fetch.download_ms": 45,
			"maple.fetch.next_hop_protocol": "h2",
			"http.response.body.size": 1234,
			"network.protocol.name": "http",
			"network.protocol.version": "2",
		})
	})

	it("reports zero setup on a reused connection", () => {
		const reused = {
			...coldEntry,
			domainLookupStart: 100,
			domainLookupEnd: 100,
			connectStart: 100,
			secureConnectionStart: 100,
			connectEnd: 100,
			requestStart: 100,
		}
		const attributes = resourceTimingAttributes(reused, undefined)
		expect(attributes["maple.fetch.dns_ms"]).toBe(0)
		expect(attributes["maple.fetch.connect_ms"]).toBe(0)
		expect(attributes["maple.fetch.tls_ms"]).toBe(0)
		expect(attributes["maple.fetch.stalled_ms"]).toBe(0)
		expect(attributes).not.toHaveProperty("maple.auth.wait_ms")
	})

	it("marks an entry without Timing-Allow-Origin instead of recording zeros", () => {
		const opaque = { ...coldEntry, requestStart: 0, responseStart: 0, domainLookupStart: 0 }
		expect(resourceTimingAttributes(opaque, 5)).toEqual({
			"maple.fetch.total_ms": 400,
			"maple.auth.wait_ms": 5,
			"maple.fetch.timing_allowed": false,
		})
	})
})

describe("resourceEntryName", () => {
	it("resolves relative URLs and drops the fragment, as resource entries do", () => {
		const base = "https://app.maple.dev/traces?x=1"
		expect(resourceEntryName("/api/v2/traces?limit=5#top", base)).toBe(
			"https://app.maple.dev/api/v2/traces?limit=5",
		)
		expect(resourceEntryName("https://api.maple.dev", base)).toBe("https://api.maple.dev/")
	})
})
