import { describe, expect, it } from "vitest"
import { generateDemoProductRows } from "./product"

const NOW = Date.parse("2026-11-03T12:00:00Z")
const rows = generateDemoProductRows({ orgId: "org_demo", hours: 6, visitorsPerHour: 40, nowMs: NOW })

const reached = (eventName: string) =>
	new Set(rows.eventRows.filter((row) => row.event_name === eventName).map((row) => row.visitor_id)).size

describe("generateDemoProductRows", () => {
	it("writes one session per visitor, and every event belongs to one of them", () => {
		const sessions = new Set(rows.sessionRows.map((row) => row.session_id))
		expect(rows.sessionRows).toHaveLength(240)
		expect(rows.eventRows.every((row) => sessions.has(row.session_id))).toBe(true)
		expect(rows.eventRows.every((row) => row.org_id === "org_demo")).toBe(true)
	})

	it("narrows down the signup funnel step by step", () => {
		const counts = ["signup_started", "signup_completed", "onboarding_connected"].map(reached)
		expect(counts[0]).toBeGreaterThan(0)
		expect(counts[1]).toBeLessThanOrEqual(counts[0] ?? 0)
		expect(counts[2]).toBeLessThanOrEqual(counts[1] ?? 0)
	})

	it("keeps every event inside the window", () => {
		const latest = rows.eventRows.map((row) => Date.parse(`${String(row.timestamp).replace(" ", "T")}Z`))
		expect(latest.every((ms) => ms <= NOW && ms >= NOW - 6 * 3600_000)).toBe(true)
	})
})
