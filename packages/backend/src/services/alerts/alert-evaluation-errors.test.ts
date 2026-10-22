import { describe, expect, it } from "@effect/vitest"
import {
	AlertValidationError,
	QueryEngineTimeoutError,
	RawSqlValidationError,
	WarehouseQuotaExceededError,
	WarehouseUpstreamError,
} from "@maple/domain/http"
import { evaluationErrorKind, isQueryLimitFailure } from "./alert-evaluation-errors"

const quota = (setting: "max_execution_time" | "max_memory_usage") =>
	new WarehouseQuotaExceededError({ message: "limit", pipeName: "alertEvaluation", setting })

describe("evaluationErrorKind", () => {
	it("tells a query that ran out of time from one that ran out of memory", () => {
		expect(evaluationErrorKind(quota("max_execution_time"))).toBe("query_too_slow")
		expect(evaluationErrorKind(quota("max_memory_usage"))).toBe("query_too_much_memory")
	})

	it("calls a query the author has to fix invalid", () => {
		expect(
			evaluationErrorKind(new RawSqlValidationError({ code: "DisallowedFunction", message: "bad" })),
		).toBe("invalid_query")
		expect(evaluationErrorKind(new AlertValidationError({ message: "bad", details: [] }))).toBe(
			"invalid_query",
		)
	})

	it("leaves the tick's own deadline and upstream failures as other", () => {
		expect(evaluationErrorKind(new QueryEngineTimeoutError({ message: "deadline" }))).toBe("other")
		expect(
			evaluationErrorKind(new WarehouseUpstreamError({ message: "502", pipeName: "alertEvaluation" })),
		).toBe("other")
		expect(evaluationErrorKind(new Error("boom"))).toBe("other")
	})
})

describe("isQueryLimitFailure", () => {
	it("counts only the failures a longer interval can fix", () => {
		expect(isQueryLimitFailure("query_too_slow")).toBe(true)
		expect(isQueryLimitFailure("query_too_much_memory")).toBe(true)
		expect(isQueryLimitFailure("invalid_query")).toBe(false)
		expect(isQueryLimitFailure("other")).toBe(false)
	})
})
