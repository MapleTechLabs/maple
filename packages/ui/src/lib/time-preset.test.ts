import { describe, expect, it } from "vitest"
import { presetLabel, presetSpanLabel } from "./time-preset"

describe("presetLabel", () => {
	it("spells out a shorthand, singular for one", () => {
		expect(presetLabel("15m")).toBe("Last 15 minutes")
		expect(presetLabel("1h")).toBe("Last 1 hour")
		expect(presetLabel("30d")).toBe("Last 30 days")
		expect(presetLabel("12mo")).toBe("Last 1 year")
		expect(presetLabel(" Today ")).toBe("Today")
	})

	it("leaves anything else as written", () => {
		expect(presetLabel("custom")).toBe("custom")
	})
})

describe("presetSpanLabel", () => {
	it("reads a preset as the span it covers in comparison copy", () => {
		expect(presetSpanLabel("1mo")).toBe("month")
		expect(presetSpanLabel("1w")).toBe("week")
		expect(presetSpanLabel("2w")).toBe("2 weeks")
		expect(presetSpanLabel("today")).toBe("day")
	})
})
