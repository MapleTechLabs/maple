import { describe, expect, it, vi, afterEach } from "vitest"
import {
	SYSTEM_VALUE,
	getBrowserTimeZone,
	normalizeStoredTimezoneValue,
	resolveEffectiveTimezone,
} from "./timezone-preference-atoms"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("timezone-preference-atoms helpers", () => {
	it("resolves system value to browser timezone", () => {
		const browserTz = getBrowserTimeZone()
		expect(resolveEffectiveTimezone(SYSTEM_VALUE)).toBe(browserTz)
	})

	it("falls back to browser timezone for invalid stored values", () => {
		const browserTz = getBrowserTimeZone()
		expect(resolveEffectiveTimezone("Not/AZone")).toBe(browserTz)
		expect(normalizeStoredTimezoneValue("Not/AZone")).toBe(SYSTEM_VALUE)
	})

	it("falls back to UTC when browser timezone is missing", () => {
		vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
			locale: "en-US",
			calendar: "gregory",
			numberingSystem: "latn",
			timeZone: "",
		})

		expect(getBrowserTimeZone()).toBe("UTC")
	})
})
