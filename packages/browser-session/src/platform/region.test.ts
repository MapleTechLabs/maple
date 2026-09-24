import { afterEach, describe, expect, it, vi } from "vitest"
import {
	ingestEndpointForRegion,
	isMapleIngestEndpoint,
	parseRegion,
	resetKeylessWarningsForTests,
	resetRegionWarningsForTests,
	resolveIngestEndpoint,
	warnIfKeylessMapleIngest,
} from "./region"

afterEach(() => {
	resetRegionWarningsForTests()
	resetKeylessWarningsForTests()
	vi.restoreAllMocks()
})

describe("region", () => {
	it("maps each region to its ingest host", () => {
		expect(ingestEndpointForRegion("us")).toBe("https://ingest.maple.dev")
		expect(ingestEndpointForRegion("eu")).toBe("https://ingest.eu.maple.dev")
		expect(ingestEndpointForRegion(undefined)).toBe("https://ingest.maple.dev")
	})

	it("parses env-style values loosely and rejects unknown ones", () => {
		expect(parseRegion(" EU ")).toBe("eu")
		expect(parseRegion("eu-central")).toBeUndefined()
		expect(parseRegion(3)).toBeUndefined()
	})

	it("falls back to the default region with one warning for an unknown value", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		expect(ingestEndpointForRegion("mars")).toBe("https://ingest.maple.dev")
		expect(ingestEndpointForRegion("mars")).toBe("https://ingest.maple.dev")
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("lets any explicit endpoint beat any region", () => {
		expect(
			resolveIngestEndpoint({ endpoints: [undefined, "https://collector.local/"], regions: ["eu"] }),
		).toBe("https://collector.local")
		expect(resolveIngestEndpoint({ endpoints: [undefined, ""], regions: [undefined, "eu"] })).toBe(
			"https://ingest.eu.maple.dev",
		)
	})

	it("recognizes Maple's hosted ingest, trailing slash or not", () => {
		expect(isMapleIngestEndpoint("https://ingest.maple.dev")).toBe(true)
		expect(isMapleIngestEndpoint("https://ingest.eu.maple.dev/")).toBe(true)
		expect(isMapleIngestEndpoint("https://INGEST.maple.dev")).toBe(true)
		expect(isMapleIngestEndpoint("https://ingest.maple.dev:443")).toBe(true)
		expect(isMapleIngestEndpoint("https://ingest.maple.dev/proxy")).toBe(false)
		expect(isMapleIngestEndpoint("https://telemetry.example.com")).toBe(false)
		expect(isMapleIngestEndpoint("not a url")).toBe(false)
	})

	it("warns once about a keyless write to the hosted ingest, and never behind a proxy", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const keyless = { logPrefix: "[t]", hasIngestKey: false, hint: "hint" }
		warnIfKeylessMapleIngest({ ...keyless, endpoint: "https://telemetry.example.com" })
		warnIfKeylessMapleIngest({ ...keyless, endpoint: "https://ingest.maple.dev", hasIngestKey: true })
		expect(warn).not.toHaveBeenCalled()

		warnIfKeylessMapleIngest({ ...keyless, endpoint: "https://ingest.maple.dev" })
		warnIfKeylessMapleIngest({ ...keyless, endpoint: "https://ingest.maple.dev" })
		expect(warn).toHaveBeenCalledTimes(1)
		expect(String(warn.mock.calls[0]![0])).toContain("401")
	})
})
