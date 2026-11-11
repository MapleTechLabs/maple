import { describe, expect, it } from "vitest"

import {
	ciResultLabel,
	ciResultTone,
	externalUrl,
	failRate,
	pullRequestUrl,
	rateChange,
	successRate,
} from "./ci-format"

describe("successRate", () => {
	it("leaves cancelled runs out of the denominator", () => {
		expect(successRate({ succeeded: 3, failed: 1 })).toBe(0.75)
	})

	it("is null when no run passed or failed", () => {
		expect(successRate({ succeeded: 0, failed: 0 })).toBeNull()
	})
})

describe("failRate", () => {
	it("is failed over all runs, null without runs", () => {
		expect(failRate(1, 4)).toBe(0.25)
		expect(failRate(0, 0)).toBeNull()
	})
})

describe("rateChange", () => {
	it("is the difference in points, null without a baseline", () => {
		expect(rateChange(0.9, 0.8)).toBeCloseTo(0.1)
		expect(rateChange(0.9, null)).toBeNull()
	})
})

describe("pullRequestUrl", () => {
	it("swaps the actions run path for the pull request", () => {
		expect(pullRequestUrl("https://github.com/acme/api/actions/runs/123/attempts/2", 42)).toBe(
			"https://github.com/acme/api/pull/42",
		)
	})

	it("is null for a URL that is not a run", () => {
		expect(pullRequestUrl("https://github.com/acme", 42)).toBeNull()
		expect(pullRequestUrl("", 42)).toBeNull()
	})
})

describe("ciResultLabel / ciResultTone", () => {
	it("reads a failing result as critical and a cancelled one as neutral", () => {
		expect(ciResultTone("failure")).toBe("crit")
		expect(ciResultTone("timeout")).toBe("crit")
		expect(ciResultTone("cancellation")).toBe("neutral")
		expect(ciResultTone("success")).toBe("ok")
	})

	it("shows an unknown result as it came, muted", () => {
		expect(ciResultLabel("stale")).toBe("stale")
		expect(ciResultTone("stale")).toBe("neutral")
	})
})

describe("externalUrl", () => {
	it("keeps http and https links", () => {
		expect(externalUrl("https://github.com/acme/web/actions/runs/1")).toBe(
			"https://github.com/acme/web/actions/runs/1",
		)
		expect(externalUrl("http://ghe.internal/acme/web/actions/runs/1")).toBe(
			"http://ghe.internal/acme/web/actions/runs/1",
		)
	})

	it("drops script, data and unparsable links", () => {
		expect(externalUrl("javascript:alert(1)")).toBeNull()
		expect(externalUrl("JavaScript:alert(1)")).toBeNull()
		expect(externalUrl("data:text/html,<script>alert(1)</script>")).toBeNull()
		expect(externalUrl("")).toBeNull()
		expect(externalUrl("/relative/path")).toBeNull()
	})
})
