import { describe, expect, test } from "vitest"
import { inferDisplayUnitForQuery } from "./drafts"

describe("inferDisplayUnitForQuery", () => {
	// `requests_per_sec` divides by the bucket width: right for per-bucket counts,
	// 60x low on a 60 s bucket for a metrics rate, which is already per second.
	test("a metrics rate is not rescaled as requests per second", () => {
		const unit = inferDisplayUnitForQuery({
			dataSource: "metrics",
			aggregation: "rate",
			metricName: "http.server.request.count",
		})
		expect(unit).not.toBe("requests_per_sec")
	})
})
