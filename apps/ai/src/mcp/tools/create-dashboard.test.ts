import { describe, expect, it } from "vitest"
import { normalizeGroupBy } from "./create-dashboard"

describe("normalizeGroupBy", () => {
	it("accepts query_data spellings", () => {
		expect(normalizeGroupBy("service", "traces")).toBe("service.name")
		expect(normalizeGroupBy("span_name", "traces")).toBe("span.name")
		expect(normalizeGroupBy("event_name", "product_events")).toBe("event.name")
	})

	it("leaves builder tokens and aliases invalid for the source alone", () => {
		expect(normalizeGroupBy("service.name", "traces")).toBe("service.name")
		expect(normalizeGroupBy("span_name", "logs")).toBe("span_name")
		expect(normalizeGroupBy("attr.signal", "metrics")).toBe("attr.signal")
	})
})
