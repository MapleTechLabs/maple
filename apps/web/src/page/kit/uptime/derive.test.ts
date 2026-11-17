import { describe, expect, it } from "vitest"
import { certificateSummary, checkHealth, formatMs, formatShare, requestLine, targetLine } from "./derive"
import { httpMonitor } from "./test-monitors"
import { Array as Arr } from "effect"

describe("checkHealth", () => {
	const ok = (latencyMs: number | null) => checkHealth({ total: 10, failed: 0, latencyMs }, 200)

	it("reads a bucket by how much of it failed before latency", () => {
		expect(
			Arr.map([0, 1, 4, 5, 10], (failed) => checkHealth({ total: 10, failed, latencyMs: 2000 }, 200)),
		).toEqual(["slow", "someFailed", "someFailed", "mostlyFailed", "mostlyFailed"])
	})

	it("grades passing checks against the median: under 1.5x fast, under 2x slower, over slow", () => {
		expect(Arr.map([200, 300, 301, 400, 401], ok)).toEqual(["fast", "fast", "slower", "slower", "slow"])
	})

	it("treats a single failed check as mostly failed, and no checks as none", () => {
		expect(checkHealth({ total: 1, failed: 1, latencyMs: 50 }, 200)).toBe("mostlyFailed")
		expect(checkHealth({ total: 0, failed: 0, latencyMs: null }, 200)).toBe("none")
	})

	it("calls a passing check fast when there is no latency or median to compare", () => {
		expect([ok(null), checkHealth({ total: 3, failed: 0, latencyMs: 900 }, null)]).toEqual([
			"fast",
			"fast",
		])
	})
})

describe("formatShare", () => {
	it("drops the decimals for every whole share, despite floating point", () => {
		expect(Arr.map([11 / 20, 7 / 100, 1, 0], formatShare)).toEqual(["55%", "7%", "100%", "0%"])
	})

	it("keeps two decimals otherwise, and a dash with no checks", () => {
		expect(Arr.map([0.9958, 2 / 3, null], formatShare)).toEqual(["99.58%", "66.67%", "–"])
	})
})

describe("formatMs", () => {
	it("switches to seconds where milliseconds would round to 1000", () => {
		expect(formatMs(999.4)).toBe("999 ms")
		expect(formatMs(999.6)).toBe("1.00 s")
	})
})

describe("certificateSummary", () => {
	const now = Date.UTC(2026, 10, 15, 12)
	const withCertificate = (days: number | null) => {
		const monitor = httpMonitor()
		const last = monitor.state.last_check
		if (last === null || days === null) return monitor
		const expires_at = new Date(now + days * 86_400_000).toISOString()
		return httpMonitor({
			state: {
				...monitor.state,
				last_check: { ...last, certificate: { expires_at, subject: "a", issuer: "b" } },
			},
		})
	}

	it("dates the expiry, warns inside 14 days and turns critical once expired", () => {
		expect(
			Arr.map([40, 9, 1, -3, null], (days) => certificateSummary(withCertificate(days), now)),
		).toEqual([
			{ text: "Dec 25, 2026 (40 days left)", tone: null },
			{ text: "Nov 24, 2026 (9 days left)", tone: "warn" },
			{ text: "Nov 16, 2026 (1 day left)", tone: "warn" },
			{ text: "Expired Nov 12, 2026", tone: "crit" },
			null,
		])
	})
})

describe("multi-step monitors", () => {
	it("read as their step count and where they start", () => {
		const monitor = httpMonitor({
			kind: "multistep",
			config: {
				type: "multistep",
				timeout_ms: 30_000,
				steps: [
					{ name: "Log in", method: "POST", url: "https://api.acme.dev/login" },
					{ name: "Orders", url: "https://api.acme.dev/orders/{{id}}" },
				],
			},
		})
		expect([targetLine(monitor, 0), requestLine(monitor)]).toEqual([
			"2 steps from api.acme.dev/login",
			"2 steps from api.acme.dev/login",
		])
	})
})
