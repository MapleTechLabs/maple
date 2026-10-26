import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
	appendRecentCheck,
	applyUptimeCheck,
	firstFailedAssertion,
	readJsonPath,
	UPTIME_RECENT_LIMIT,
	type UptimeHttpObservation,
} from "./uptime"

const observed = (overrides: Partial<UptimeHttpObservation> = {}): UptimeHttpObservation => ({
	statusCode: 200,
	durationMs: 96,
	headers: { "content-type": "application/json" },
	body: '{"status":"ok","checks":[{"name":"db","status":"ok"}]}',
	...overrides,
})

describe("firstFailedAssertion", () => {
	it("passes a healthy response", () => {
		expect(
			firstFailedAssertion(
				[
					{ _tag: "status", op: "is", value: "2xx" },
					{ _tag: "latency", underMs: 2000 },
					{ _tag: "body", op: "contains", value: '"status":"ok"' },
					{ _tag: "json_path", path: "checks[0].status", op: "equals", value: "ok" },
					{ _tag: "header", name: "Content-Type", op: "contains", value: "json" },
				],
				observed(),
			),
		).toBeNull()
	})

	it("reports the first failure as one sentence", () => {
		expect(
			firstFailedAssertion(
				[
					{ _tag: "status", op: "is", value: "2xx" },
					{ _tag: "latency", underMs: 50 },
				],
				observed({ statusCode: 503 }),
			),
		).toBe("Status 503, expected 2xx")
	})

	it("matches exact status codes and negations", () => {
		expect(firstFailedAssertion([{ _tag: "status", op: "is", value: "204" }], observed({ statusCode: 204 }))).toBeNull()
		expect(firstFailedAssertion([{ _tag: "status", op: "is_not", value: "5xx" }], observed({ statusCode: 502 }))).toBe(
			"Status 502, expected not 5xx",
		)
	})

	it("fails latency at the threshold", () => {
		expect(firstFailedAssertion([{ _tag: "latency", underMs: 96 }], observed())).toBe(
			"Responded in 96 ms, expected under 96 ms",
		)
	})

	it("fails json_path on a non-JSON body", () => {
		expect(
			firstFailedAssertion([{ _tag: "json_path", path: "status", op: "exists" }], observed({ body: "<html>" })),
		).toBe("JSON path status not found")
	})

	it("treats a missing header as a failure", () => {
		expect(firstFailedAssertion([{ _tag: "header", name: "x-version", op: "exists" }], observed())).toBe(
			"Header x-version missing",
		)
	})
})

describe("readJsonPath", () => {
	it("walks objects and array indexes", () => {
		expect(readJsonPath({ a: [{ b: 3 }] }, "a[0].b")).toEqual(Option.some(3))
		expect(readJsonPath({ a: [] }, "a[2]")).toEqual(Option.none())
	})
})

describe("applyUptimeCheck", () => {
	const pending = { status: "pending", consecutiveFailures: 0, consecutiveSuccesses: 0 } as const

	it("goes down only after the configured failures in a row", () => {
		const once = applyUptimeCheck(pending, false, 2)
		expect(once.status).toBe("pending")
		expect(applyUptimeCheck(once, false, 2).status).toBe("down")
	})

	it("recovers on the first success", () => {
		const down = { status: "down", consecutiveFailures: 5, consecutiveSuccesses: 0 } as const
		expect(applyUptimeCheck(down, true, 2)).toEqual({ status: "up", consecutiveFailures: 0, consecutiveSuccesses: 1 })
	})

	it("leaves a paused monitor alone", () => {
		const paused = { status: "paused", consecutiveFailures: 0, consecutiveSuccesses: 0 } as const
		expect(applyUptimeCheck(paused, false, 1)).toBe(paused)
	})
})

describe("appendRecentCheck", () => {
	it("keeps only the newest checks", () => {
		const full = Array.from({ length: UPTIME_RECENT_LIMIT }, (_, at) => ({ at, ok: true, durationMs: 1 }))
		const next = appendRecentCheck(full, { at: 999, ok: false, durationMs: null })
		expect(next).toHaveLength(UPTIME_RECENT_LIMIT)
		expect(next.at(-1)?.at).toBe(999)
		expect(next[0]?.at).toBe(1)
	})
})
