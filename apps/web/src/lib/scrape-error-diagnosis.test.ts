import { describe, expect, it } from "vitest"
import { diagnoseScrapeError } from "./scrape-error-diagnosis"

describe("diagnoseScrapeError", () => {
	it("returns null for empty input", () => {
		expect(diagnoseScrapeError(null, "planetscale")).toBeNull()
		expect(diagnoseScrapeError("", "planetscale")).toBeNull()
		expect(diagnoseScrapeError("   ", "planetscale")).toBeNull()
	})

	it("diagnoses HTTP 429 as a rate limit (warning) with PlanetScale guidance", () => {
		const d = diagnoseScrapeError("target returned HTTP 429", "planetscale")
		expect(d?.severity).toBe("warning")
		expect(d?.title).toBe("Rate limited")
		expect(d?.fixes.join(" ")).toContain("interval")
		expect(d?.fixes.join(" ")).toContain("branch")
	})

	it("strips the [branch:…] rollup prefix before diagnosing", () => {
		const d = diagnoseScrapeError("[branch:main] target returned HTTP 429", "planetscale")
		expect(d?.title).toBe("Rate limited")
		expect(d?.summary).not.toContain("[branch")
	})

	it("diagnoses 401/403 as an auth problem mentioning the token permission", () => {
		for (const status of [401, 403]) {
			const d = diagnoseScrapeError(`target returned HTTP ${status}`, "planetscale")
			expect(d?.severity).toBe("error")
			expect(d?.title).toBe("Authentication rejected")
			expect(d?.fixes.join(" ")).toContain("read_metrics_endpoints")
		}
	})

	it("diagnoses 404 as endpoint not found", () => {
		const d = diagnoseScrapeError("target returned HTTP 404", "planetscale")
		expect(d?.title).toBe("Endpoint not found")
		expect(d?.fixes.join(" ").toLowerCase()).toContain("organization")
	})

	it("treats 5xx as a transient upstream warning", () => {
		const d = diagnoseScrapeError("target returned HTTP 503", "planetscale")
		expect(d?.severity).toBe("warning")
		expect(d?.title).toBe("PlanetScale-side error")
	})

	it("diagnoses timeouts", () => {
		expect(diagnoseScrapeError("The operation was aborted", "prometheus")?.title).toBe(
			"Request timed out",
		)
		expect(
			diagnoseScrapeError("PlanetScale discovery request timed out after 10s", "planetscale")?.title,
		).toBe("Request timed out")
	})

	it("recognizes discovery-stage failures without a status", () => {
		const d = diagnoseScrapeError("PlanetScale discovery request failed: ENOTFOUND", "planetscale")
		expect(d?.title).toBe("Discovery failed")
	})

	it("omits PlanetScale-specific copy for generic prometheus targets", () => {
		const d = diagnoseScrapeError("target returned HTTP 429", "prometheus")
		expect(d?.title).toBe("Rate limited")
		expect(d?.fixes.join(" ")).not.toContain("branch")
		expect(d?.fixes.join(" ")).not.toContain("PlanetScale")
	})

	it("falls back to surfacing the raw message for unrecognized errors", () => {
		const d = diagnoseScrapeError("something weird happened", "prometheus")
		expect(d?.title).toBe("Scrape failed")
		expect(d?.summary).toBe("something weird happened")
	})
})
