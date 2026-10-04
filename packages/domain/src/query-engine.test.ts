import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { QuerySpec, describeQuerySpecDecodeError } from "./query-engine"

const unionMessage = (raw: unknown): string => {
	const result = Schema.decodeUnknownResult(QuerySpec)(raw)
	return result._tag === "Failure" ? result.failure.message : ""
}

describe("describeQuerySpecDecodeError", () => {
	it("reports only the arm the caller targeted, on one line", () => {
		const raw = {
			kind: "breakdown",
			source: "metrics",
			metric: "p95",
			groupBy: "service",
			filters: { metricName: "a", metricType: "sum" },
		}
		const message = describeQuerySpecDecodeError(raw, unionMessage(raw))
		expect(message).toBe(
			'Invalid query for source=metrics kind=breakdown: Expected "avg" | "sum" | "min" | "max" | "count" | "rate" | "increase" at ["metric"]',
		)
	})

	it("accepts every metrics aggregation in a breakdown", () => {
		for (const metric of ["min", "max", "rate", "increase"]) {
			const raw = {
				kind: "breakdown",
				source: "metrics",
				metric,
				groupBy: "service",
				filters: { metricName: "a", metricType: "sum" },
			}
			expect(Schema.decodeUnknownResult(QuerySpec)(raw)._tag).toBe("Success")
		}
	})

	it("falls back to a single line for an unknown source/kind", () => {
		const raw = { kind: "nope", source: "metrics" }
		expect(describeQuerySpecDecodeError(raw, unionMessage(raw))).not.toContain("\n")
	})
})
