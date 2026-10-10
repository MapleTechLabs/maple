import { describe, expect, it } from "vitest"

import { severityLabel } from "./severity-badge"

describe("severityLabel", () => {
	it("keeps the text when present", () => {
		expect(severityLabel("warning", 13)).toBe("warning")
	})

	it("derives the OTel range from the number when text is empty", () => {
		expect(severityLabel("", 1)).toBe("TRACE")
		expect(severityLabel("", 9)).toBe("INFO")
		expect(severityLabel(" ", 17)).toBe("ERROR")
		expect(severityLabel("", 24)).toBe("FATAL")
	})

	it("falls back to UNSET", () => {
		expect(severityLabel("", 0)).toBe("UNSET")
		expect(severityLabel("")).toBe("UNSET")
		expect(severityLabel("", 30)).toBe("UNSET")
	})
})
