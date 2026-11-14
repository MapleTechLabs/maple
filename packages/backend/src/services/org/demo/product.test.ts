import { Array as Arr, Effect, Random, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { generateDemoProductRows } from "./product"

const NOW = Date.parse("2026-11-03T12:00:00Z")
const rows = Effect.runSync(
	Effect.gen(function* () {
		const random = yield* Random.Random
		return generateDemoProductRows({
			orgId: "org_demo",
			hours: 6,
			visitorsPerHour: 40,
			nowMs: NOW,
			random: () => random.nextDoubleUnsafe(),
		})
	}).pipe(Random.withSeed("demo-product")),
)

const reached = (eventName: string) =>
	new Set(
		Arr.map(
			Arr.filter(rows.eventRows, (row) => row.event_name === eventName),
			(row) => row.visitor_id,
		),
	).size

describe("generateDemoProductRows", () => {
	it("writes one session per visitor, and every event belongs to one of them", () => {
		const sessions = new Set(Arr.map(rows.sessionRows, (row) => row.session_id))
		expect(rows.sessionRows).toHaveLength(240)
		expect(Arr.every(rows.eventRows, (row) => sessions.has(row.session_id))).toBe(true)
		expect(Arr.every(rows.eventRows, (row) => row.org_id === "org_demo")).toBe(true)
	})

	it("narrows down the signup funnel step by step", () => {
		const counts = Arr.map(["signup_started", "signup_completed", "onboarding_connected"], reached)
		expect(counts[0]).toBeGreaterThan(0)
		expect(counts[1]).toBeLessThanOrEqual(counts[0] ?? 0)
		expect(counts[2]).toBeLessThanOrEqual(counts[1] ?? 0)
	})

	it("keeps every event inside the window", () => {
		const latest = Arr.map(rows.eventRows, (row) =>
			Date.parse(`${Str.replace(" ", "T")(String(row.timestamp))}Z`),
		)
		expect(Arr.every(latest, (ms) => ms <= NOW && ms >= NOW - 6 * 3600_000)).toBe(true)
	})
})
