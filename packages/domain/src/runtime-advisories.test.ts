import { describe, expect, it } from "vitest"
import {
	advisoryTargetOf,
	fixedVersionFor,
	type RuntimeAdvisory,
	severityOf,
	sortAdvisories,
	summarizeAdvisories,
} from "./runtime-advisories"

const advisory = (overrides: Partial<RuntimeAdvisory>): RuntimeAdvisory => ({
	id: "CVE-2026-0001",
	osvId: "BIT-node-2026-0001",
	summary: null,
	severity: "medium",
	fixedIn: null,
	published: null,
	...overrides,
})

describe("advisoryTargetOf", () => {
	it("looks up the normalized version of a runtime OSV covers", () => {
		expect(
			advisoryTargetOf({ runtimeName: "nodejs", runtimeVersion: "v22.4.0", sdkLanguage: "nodejs" }),
		).toEqual({
			product: "nodejs",
			version: "22.4.0",
		})
		expect(
			advisoryTargetOf({ runtimeName: "go", runtimeVersion: "go1.22.1", sdkLanguage: "go" }),
		).toEqual({
			product: "go",
			version: "1.22.1",
		})
	})

	it("skips runtimes with no version, Bun posing as Node.js, and runtimes OSV does not cover", () => {
		expect(
			advisoryTargetOf({ runtimeName: "nodejs", runtimeVersion: "", sdkLanguage: "nodejs" }),
		).toBeUndefined()
		expect(
			advisoryTargetOf({
				runtimeName: "nodejs",
				runtimeVersion: "v22.6.0",
				sdkLanguage: "nodejs",
				executableName: "bun",
			}),
		).toBeUndefined()
		expect(
			advisoryTargetOf({ runtimeName: "deno", runtimeVersion: "2.1.0", sdkLanguage: "" }),
		).toBeUndefined()
		expect(
			advisoryTargetOf({ runtimeName: "workerd", runtimeVersion: "", sdkLanguage: "nodejs" }),
		).toBeUndefined()
	})
})

describe("fixedVersionFor", () => {
	// CVE-2023-46809 as OSV publishes it for Node.js.
	const events = [
		{ introduced: "0" },
		{ fixed: "18.19.1" },
		{ introduced: "19.0.0" },
		{ fixed: "20.11.1" },
		{ introduced: "21.0.0" },
		{ fixed: "21.6.1" },
	]

	it("returns the fix of the line the version is on", () => {
		expect(fixedVersionFor(events, "20.10.0")).toBe("20.11.1")
		expect(fixedVersionFor(events, "16.20.2")).toBe("18.19.1")
		expect(fixedVersionFor(events, "21.0.0")).toBe("21.6.1")
	})

	it("returns null when the version is past every fix or the range never closes", () => {
		expect(fixedVersionFor(events, "20.11.1")).toBeNull()
		expect(fixedVersionFor([{ introduced: "3.0.0" }], "3.1.0")).toBeNull()
	})
})

describe("severityOf", () => {
	it("reads OSV's severity labels and calls anything else unknown", () => {
		expect(severityOf("Critical")).toBe("critical")
		expect(severityOf("High")).toBe("high")
		expect(severityOf("Unknown")).toBe("unknown")
		expect(severityOf("moderate")).toBe("unknown")
		expect(severityOf(undefined)).toBe("unknown")
	})
})

describe("summarizeAdvisories", () => {
	it("counts by severity and names the version that fixes the critical and high ones", () => {
		const summary = summarizeAdvisories([
			advisory({ severity: "critical", fixedIn: "22.21.2" }),
			advisory({ severity: "high", fixedIn: "22.9.0" }),
			advisory({ severity: "high", fixedIn: null }),
			// Medium and low fixes often exist only in the newest line, so they do not set the target.
			advisory({ severity: "medium", fixedIn: "24.1.0" }),
			advisory({ severity: "low", fixedIn: null }),
		])
		expect(summary).toEqual({
			total: 5,
			counts: { critical: 1, high: 2, medium: 1, low: 1, unknown: 0 },
			worst: "critical",
			urgent: true,
			upgradeTo: "22.21.2",
			unfixed: 1,
		})
	})

	it("is not urgent with only medium and low advisories, and calm with none", () => {
		expect(summarizeAdvisories([advisory({ severity: "medium" })]).urgent).toBe(false)
		expect(summarizeAdvisories([])).toMatchObject({ total: 0, worst: null, upgradeTo: null })
	})
})

describe("sortAdvisories", () => {
	it("puts the worst first, then the newest", () => {
		const sorted = sortAdvisories([
			advisory({ id: "low", severity: "low", published: "2026-10-01" }),
			advisory({ id: "old-high", severity: "high", published: "2025-01-01" }),
			advisory({ id: "critical", severity: "critical", published: "2024-01-01" }),
			advisory({ id: "new-high", severity: "high", published: "2026-09-01" }),
		])
		expect(sorted.map((entry) => entry.id)).toEqual(["critical", "new-high", "old-high", "low"])
	})
})
