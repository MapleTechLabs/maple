import { describe, expect, test } from "vitest"
import { Array as Arr } from "effect"
import { deployBefore, deployChecks, judge, leadDeploy, railOrder } from "./derive-deploys"
import type { DeployRow } from "./model-deploys"

const MINUTE = 60_000
const NOW = Date.parse("2026-11-15T12:00:00Z")
const WINDOW = 1800

const row = (sha: string, minutesAgo: number, patch: Partial<DeployRow> = {}): DeployRow => ({
	serviceName: "api",
	environment: "production",
	commitSha: sha,
	firstSeen: new Date(NOW - minutesAgo * MINUTE).toISOString(),
	afterSpans: 3000,
	afterErrors: 30,
	afterP95Ms: 100,
	beforeSpans: 3000,
	beforeErrors: 30,
	beforeP95Ms: 100,
	...patch,
})

describe("judge", () => {
	test("a deploy that doubled its error rate is flagged errors-up", () => {
		expect(judge(row("a", 45, { afterErrors: 300 }), WINDOW, NOW).verdict).toBe("errors-up")
	})

	test("a doubling too small to matter stays clean", () => {
		// 0.1% → 0.3%: three times as often, but under half a point apart.
		const check = judge(row("a", 45, { beforeErrors: 3, afterErrors: 9 }), WINDOW, NOW)
		expect(check.verdict).toBe("clean")
	})

	test("exactly half a point more, twice as often, counts despite float rounding", () => {
		// 0.4% → 0.9%: 9/1000 - 4/1000 is a hair under 0.005 in floating point.
		const check = judge(
			row("a", 45, { beforeErrors: 4, afterErrors: 9, afterSpans: 1000, beforeSpans: 1000 }),
			WINDOW,
			NOW,
		)
		expect(check.verdict).toBe("errors-up")
	})

	test("errors from none at all count as up", () => {
		const check = judge(row("a", 45, { beforeErrors: 0, afterErrors: 60 }), WINDOW, NOW)
		expect(check.verdict).toBe("errors-up")
	})

	test("p95 up a quarter and at least 10ms is slower", () => {
		expect(judge(row("a", 45, { afterP95Ms: 130 }), WINDOW, NOW).verdict).toBe("slower")
	})

	test("a quarter slower but only a few milliseconds is not flagged", () => {
		const check = judge(row("a", 45, { beforeP95Ms: 4, afterP95Ms: 8 }), WINDOW, NOW)
		expect(check.verdict).toBe("clean")
	})

	test("inside its first half hour a quiet deploy is still verifying, with the minutes elapsed", () => {
		const check = judge(row("a", 12), WINDOW, NOW)
		expect(check.verdict).toBe("verifying")
		expect(check.minutes).toBe(12)
		expect(check.windowMinutes).toBe(30)
	})

	test("a past range counts minutes up to its end, not up to now", () => {
		// Deployed 10 minutes before the range ended: still verifying, though now is hours later.
		const rangeEnd = NOW - 10 * MINUTE
		const check = judge(row("a", 20), WINDOW, rangeEnd)
		expect(check.verdict).toBe("verifying")
		expect(check.minutes).toBe(10)
	})

	test("a flag lands before the window is up", () => {
		expect(judge(row("a", 12, { afterErrors: 300 }), WINDOW, NOW).verdict).toBe("errors-up")
	})

	test("too little traffic on either side leaves a settled deploy unjudged", () => {
		expect(judge(row("a", 45, { beforeSpans: 10 }), WINDOW, NOW).verdict).toBe("unjudged")
	})
})

describe("deployChecks", () => {
	test("a commit in two environments is two deploys, each with its own verdict, newest first", () => {
		const checks = deployChecks(
			{
				deploys: [
					row("old", 300),
					row("new", 60),
					row("new", 58, { environment: "staging", afterErrors: 300 }),
				],
				verifyWindowSeconds: WINDOW,
				readUntil: "2026-11-15 12:00:00",
			},
			NOW,
		)
		expect(Arr.map(checks, (check) => [check.sha, check.environment, check.verdict])).toEqual([
			["new", "staging", "errors-up"],
			["new", "production", "clean"],
			["old", "production", "clean"],
		])
	})
})

describe("leadDeploy and railOrder", () => {
	const checks = deployChecks(
		{
			deploys: [row("fresh", 5), row("bad", 120, { afterErrors: 300 }), row("fine", 200)],
			verifyWindowSeconds: WINDOW,
			readUntil: "2026-11-15 12:00:00",
		},
		NOW,
	)

	test("the callout leads with a flagged deploy over a newer one still verifying", () => {
		expect(leadDeploy(checks)?.sha).toBe("bad")
	})

	test("with nothing flagged it shows the deploy still verifying", () => {
		expect(leadDeploy(Arr.filter(checks, (check) => check.sha !== "bad"))?.sha).toBe("fresh")
	})

	test("nothing to lead with once every deploy settled clean", () => {
		expect(leadDeploy(Arr.filter(checks, (check) => check.sha === "fine"))).toBeUndefined()
	})

	test("the rail puts flagged deploys first, then newest", () => {
		expect(Arr.map(railOrder(checks), (check) => check.sha)).toEqual(["bad", "fresh", "fine"])
	})
})

describe("deployBefore", () => {
	const checks = deployChecks(
		{
			deploys: [row("first", 120), row("second", 30)],
			verifyWindowSeconds: WINDOW,
			readUntil: "2026-11-15 12:00:00",
		},
		NOW,
	)

	test("an issue is attributed to the newest deploy before it first appeared", () => {
		expect(deployBefore(checks, NOW - 10 * MINUTE, NOW)?.sha).toBe("second")
		expect(deployBefore(checks, NOW - 60 * MINUTE, NOW)?.sha).toBe("first")
	})

	test("an issue first seen after the window ended came with a deploy the window does not show", () => {
		expect(deployBefore(checks, NOW + 60 * MINUTE, NOW)).toBeUndefined()
	})

	test("an issue older than every deploy in the window has none", () => {
		expect(deployBefore(checks, NOW - 200 * MINUTE, NOW)).toBeUndefined()
	})
})
