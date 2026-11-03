import { describe, expect, it } from "vitest"
import { failureGroupMessage } from "./server"
import { String as Str } from "effect"

describe("failureGroupMessage", () => {
	it("masks the per-call values so one cause reads the same every time", () => {
		const at = (start: string, now: string) =>
			failureGroupMessage(
				`Invalid input (\`start_time\`): start_time (${start}) is not in the past: server now is ${now} UTC.`,
			)
		expect(at("2026-11-03 05:40:00", "2026-11-03 05:35:40")).toBe(
			at("2026-10-30 17:20:00", "2026-10-30 17:11:46"),
		)
		expect(at("2026-11-03 05:40:00", "2026-11-03 05:35:40")).toContain("start_time (<time>)")
	})

	it("masks ids and counts but keeps the words that name the cause", () => {
		expect(
			failureGroupMessage(
				"Breakdown would scan too many spans\nThis window holds about 956M spans for issue iss_01JABCDEFGHJK and trace 0af7651916cd43dd8448eb211c80319c",
			),
		).toBe(
			"Breakdown would scan too many spans\nThis window holds about <n>M spans for issue <id> and trace <id>",
		)
	})

	it("keeps HTTP statuses and parameter names, which name the cause", () => {
		expect(failureGroupMessage("Query failed: HTTP 503 from the warehouse")).toBe(
			"Query failed: HTTP 503 from the warehouse",
		)
		expect(failureGroupMessage("`span_attributes` is not a parameter")).toBe(
			"`span_attributes` is not a parameter",
		)
	})

	it("keeps a message without per-call values as it is, clipped for the span", () => {
		expect(failureGroupMessage("Unavailable: GitHub is not connected.")).toBe(
			"Unavailable: GitHub is not connected.",
		)
		expect(failureGroupMessage(Str.repeat(1_000)("x"))).toHaveLength(300)
	})
})
