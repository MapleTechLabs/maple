import { describe, expect, it } from "vitest"
import {
	advisoryTargetOf,
	fixedVersionFor,
	inAdvisoryRange,
	isPatched,
	patchedVersionFor,
	rangeEndFor,
	type RuntimeAdvisory,
	severityOf,
	sortAdvisories,
	summarizeAdvisories,
} from "./runtime-advisories"

const advisory = (overrides: Partial<RuntimeAdvisory>): RuntimeAdvisory => ({
	id: "CVE-2026-0001",
	url: "https://osv.dev/vulnerability/BIT-node-2026-0001",
	summary: null,
	severity: "medium",
	fixedIn: null,
	published: null,
	...overrides,
})

describe("advisoryTargetOf", () => {
	it("looks up the normalized version of a tracked runtime", () => {
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
		expect(
			advisoryTargetOf({ runtimeName: "bun", runtimeVersion: "1.4.0", sdkLanguage: "nodejs" }),
		).toEqual({
			product: "bun",
			version: "1.4.0",
		})
	})

	it("skips runtimes with no version, Bun posing as Node.js, and untracked runtimes", () => {
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
		expect(severityOf("moderate")).toBe("medium")
		expect(severityOf("informational")).toBe("unknown")
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

describe("inAdvisoryRange", () => {
	it("matches comma-joined bounds, as Bun publishes them", () => {
		expect(inAdvisoryRange(">= 1.0.21, < 1.4.4", "1.4.0")).toBe(true)
		expect(inAdvisoryRange(">= 1.0.21, < 1.4.4", "1.4.4")).toBe(false)
		expect(inAdvisoryRange(">= 1.0.21, < 1.4.4", "1.0.20")).toBe(false)
		expect(inAdvisoryRange("< 1.4.4", "0.8.1")).toBe(true)
	})

	it("reads Deno's spellings: v prefixes, stray spaces, inclusive spans and bare versions", () => {
		expect(inAdvisoryRange("< v2.7.10", "2.7.9")).toBe(true)
		expect(inAdvisoryRange(" >= v2.7.0", "2.7.0")).toBe(true)
		expect(inAdvisoryRange("<= 2.8.0", "2.8.0")).toBe(true)
		expect(inAdvisoryRange("1.5.0 - 1.10.1", "1.10.1")).toBe(true)
		expect(inAdvisoryRange("1.5.0 - 1.10.1", "1.10.2")).toBe(false)
		expect(inAdvisoryRange("2.6.7", "2.6.7")).toBe(true)
		expect(inAdvisoryRange("2.6.7", "2.6.8")).toBe(false)
	})

	it("reads space-separated bounds", () => {
		// CVE-2025-24015 as Deno publishes it.
		expect(inAdvisoryRange("> 1.46.0 <= 2.1.6", "2.1.0")).toBe(true)
		expect(inAdvisoryRange("> 1.46.0 <= 2.1.6", "1.46.0")).toBe(false)
	})

	it("reads a list of upper bounds as one per release line", () => {
		expect(inAdvisoryRange("<1.46.4, <2.1.2", "2.0.0")).toBe(true)
		expect(inAdvisoryRange("<=2.1.12, <=2.2.12", "2.2.5")).toBe(true)
		expect(inAdvisoryRange("<=2.1.12, <=2.2.12", "2.3.0")).toBe(false)
	})

	it("matches nothing for an empty or unreadable range", () => {
		expect(inAdvisoryRange("", "1.0.0")).toBe(false)
		expect(inAdvisoryRange("< latest", "1.0.0")).toBe(false)
	})
})

describe("rangeEndFor", () => {
	it("returns the exclusive upper bound above the version", () => {
		expect(rangeEndFor(">= 1.36.2, < 1.40.3", "1.38.0")).toBe("1.40.3")
		expect(rangeEndFor("<1.46.4, <2.1.2", "2.0.0")).toBe("2.1.2")
	})

	it("returns null for an inclusive or open range", () => {
		expect(rangeEndFor("<= 2.8.0", "2.1.0")).toBeNull()
		expect(rangeEndFor(">= 2.0.0", "2.1.0")).toBeNull()
	})
})

describe("patchedVersionFor", () => {
	it("returns the lowest patched version above the running one", () => {
		expect(patchedVersionFor("1.4.4", "1.4.0")).toBe("1.4.4")
		expect(patchedVersionFor("1.3.14, 1.4.4", "1.4.0")).toBe("1.4.4")
		expect(patchedVersionFor(" 1.42.0, v1.41.3", "1.41.0")).toBe("1.41.3")
	})

	it("returns null when nothing is patched yet", () => {
		expect(patchedVersionFor("", "1.4.0")).toBeNull()
		expect(patchedVersionFor(null, "1.4.0")).toBeNull()
	})
})

describe("isPatched", () => {
	it("closes an open range with the newest patched version", () => {
		// Deno publishes `>= 2.0.0` patched in `2.7.8`.
		expect(isPatched("2.7.8", "2.8.1")).toBe(true)
		expect(isPatched("2.7.8", "2.7.7")).toBe(false)
		expect(isPatched(">= 2.2.5", "2.2.5")).toBe(true)
	})

	it("only counts an older line's patch for versions on that line", () => {
		expect(isPatched("2.1.13, 2.2.13, >=2.3.3", "2.1.20")).toBe(true)
		expect(isPatched("2.1.13, 2.2.13, >=2.3.3", "2.2.0")).toBe(false)
		expect(isPatched("2.1.13, 2.2.13, >=2.3.3", "2.5.0")).toBe(true)
		expect(isPatched("2.1.13, 2.2.13, >=2.3.3", "2.0.9")).toBe(false)
	})

	it("is never patched without a readable patched version", () => {
		expect(isPatched("", "9.0.0")).toBe(false)
		expect(isPatched(null, "9.0.0")).toBe(false)
	})
})
