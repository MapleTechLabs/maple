import { describe, expect, it } from "vitest"
import { widerPreset } from "./update"

const window = (days: number) => ({
	startTime: "2026-08-01 00:00:00",
	endTime: new Date(Date.UTC(2026, 7, 1) + days * 86_400_000).toISOString().replace("T", " ").slice(0, 19),
})

describe("widerPreset", () => {
	it("offers the first preset longer than the window shown", () => {
		expect(widerPreset(window(1))).toBe("1w")
		expect(widerPreset(window(7))).toBe("1mo")
		expect(widerPreset(window(30))).toBe("3mo")
	})

	it("never narrows a long custom range, and stops at three months", () => {
		expect(widerPreset(window(90))).toBeUndefined()
		expect(widerPreset(window(120))).toBeUndefined()
	})
})
