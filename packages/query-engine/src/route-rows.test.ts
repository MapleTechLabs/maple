import { describe, expect, it } from "vitest"
import { coerceServiceOverviewRow } from "./route-rows"

describe("coerceServiceOverviewRow", () => {
	it("labels a missing environment unknown, whether absent or empty", () => {
		expect(coerceServiceOverviewRow({ serviceName: "api", environment: "" }, 60).environment).toBe("unknown")
		expect(coerceServiceOverviewRow({ serviceName: "api" }, 60).environment).toBe("unknown")
		expect(coerceServiceOverviewRow({ serviceName: "api", environment: "production" }, 60).environment).toBe(
			"production",
		)
	})
})
