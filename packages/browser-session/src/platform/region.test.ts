import { afterEach, describe, expect, it, vi } from "vitest"
import {
	ingestEndpointForRegion,
	parseRegion,
	resetRegionWarningsForTests,
	resolveIngestEndpoint,
} from "./region"

afterEach(() => {
	resetRegionWarningsForTests()
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
})
