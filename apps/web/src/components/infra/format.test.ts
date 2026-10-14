import { describe, expect, it } from "vitest"
import {
	capacityFraction,
	deriveHostStatus,
	formatBytesOfAllocatable,
	formatCoresOfAllocatable,
	severityLevel,
} from "./format"

describe("deriveHostStatus", () => {
	const now = new Date("2026-04-24T12:00:00Z").getTime()

	it("returns active for recent last-seen (under 60s)", () => {
		expect(deriveHostStatus("2026-04-24T11:59:45Z", now)).toBe("active")
	})

	it("returns idle when last-seen is past 2x scrape interval but under 10x", () => {
		expect(deriveHostStatus("2026-04-24T11:58:30Z", now)).toBe("idle")
	})

	it("returns ended when last-seen is older than 10x scrape interval", () => {
		expect(deriveHostStatus("2026-04-24T11:55:00Z", now)).toBe("ended")
	})

	it("returns ended for a malformed ISO string", () => {
		expect(deriveHostStatus("not-a-date", now)).toBe("ended")
	})
})

describe("severityLevel", () => {
	it("returns ok below 60%", () => {
		expect(severityLevel(0)).toBe("ok")
		expect(severityLevel(0.59)).toBe("ok")
	})

	it("returns warn between 60% and 90%", () => {
		expect(severityLevel(0.6)).toBe("warn")
		expect(severityLevel(0.89)).toBe("warn")
	})

	it("returns crit at or above 90%", () => {
		expect(severityLevel(0.9)).toBe("crit")
		expect(severityLevel(1)).toBe("crit")
	})

	it("returns ok for non-finite input", () => {
		expect(severityLevel(Number.NaN)).toBe("ok")
	})
})

describe("node capacity", () => {
	it("keeps the utilization when allocatable was collected", () => {
		expect(capacityFraction(0.25, 4)).toBe(0.25)
	})

	it("is NaN when allocatable was not collected, so it renders a dash", () => {
		expect(capacityFraction(0, 0)).toBeNaN()
	})

	it("formats cores against allocatable", () => {
		expect(formatCoresOfAllocatable(0.4231, 3.92)).toBe("0.42 / 3.92 cores")
		expect(formatCoresOfAllocatable(0.4231, 0)).toBe("0.42 cores")
	})

	it("formats memory against allocatable", () => {
		expect(formatBytesOfAllocatable(3 * 1024 ** 3, 16 * 1024 ** 3)).toBe("3.0 GB / 16.0 GB")
		expect(formatBytesOfAllocatable(3 * 1024 ** 3, 0)).toBe("3.0 GB")
	})
})
