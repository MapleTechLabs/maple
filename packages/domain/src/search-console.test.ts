import { describe, expect, it } from "vitest"
import { completeThrough, pacificToday } from "./search-console"

describe("completeThrough", () => {
	it("stops at yesterday while the watermark holds today's partial day", () => {
		expect(completeThrough("2026-11-08", "2026-11-08")).toBe("2026-11-07")
	})

	it("is the watermark when the import lags behind yesterday", () => {
		expect(completeThrough("2026-11-03", "2026-11-08")).toBe("2026-11-03")
	})

	it("crosses a month boundary", () => {
		expect(completeThrough("2026-12-01", "2026-12-01")).toBe("2026-11-30")
	})
})

describe("pacificToday", () => {
	it("is still the previous day in Pacific time early in the UTC morning", () => {
		expect(pacificToday(Date.parse("2026-11-08T05:00:00Z"))).toBe("2026-11-07")
	})
})
