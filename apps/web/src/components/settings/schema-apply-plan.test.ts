import { describe, expect, it } from "vitest"
import { columnDriftResolvedByApply, schemaApplyPlan, schemaDiffCounts } from "./schema-apply-plan"

describe("schemaApplyPlan", () => {
	it("creates missing objects and adds only missing columns to drifted tables", () => {
		const plan = schemaApplyPlan([
			{ status: "up_to_date", name: "logs", kind: "table" },
			{ status: "missing", name: "traces_mv", kind: "materialized_view" },
			{
				status: "drifted",
				name: "traces",
				kind: "table",
				columnDrifts: [
					{ kind: "missing", column: "SpanKind", expectedType: "LowCardinality(String)" },
					{
						kind: "type_mismatch",
						column: "Duration",
						expectedType: "UInt64",
						actualType: "Int64",
					},
				],
			},
		])

		expect(plan.create).toEqual(["traces_mv"])
		expect(plan.addColumns).toEqual([{ name: "traces", columns: ["SpanKind"] }])
		// The column is added, but the type mismatch on the same table stays for a human.
		expect(plan.unresolved).toEqual([{ name: "traces", reason: "type mismatch on Duration" }])
	})

	it("leaves wrong-kind objects and drifted views untouched", () => {
		const plan = schemaApplyPlan([
			{ status: "wrong_kind", name: "errors_mv", kind: "materialized_view", actualKind: "table" },
			{
				status: "drifted",
				name: "metrics_mv",
				kind: "materialized_view",
				columnDrifts: [{ kind: "missing", column: "Value", expectedType: "Float64" }],
			},
		])

		expect(plan.create).toEqual([])
		expect(plan.addColumns).toEqual([])
		expect(plan.unresolved).toEqual([
			{ name: "errors_mv", reason: "exists as a table" },
			{ name: "metrics_mv", reason: "view definition drifted" },
		])
	})
})

describe("schemaDiffCounts", () => {
	it("counts every diff state, including wrong-kind objects", () => {
		expect(
			schemaDiffCounts([
				{ status: "up_to_date", name: "logs", kind: "table" },
				{ status: "up_to_date", name: "traces", kind: "table" },
				{ status: "missing", name: "traces_mv", kind: "materialized_view" },
				{ status: "wrong_kind", name: "errors_mv", kind: "materialized_view", actualKind: "table" },
			]),
		).toEqual({ up_to_date: 2, missing: 1, drifted: 0, wrong_kind: 1 })
	})
})

describe("columnDriftResolvedByApply", () => {
	it("adds missing columns to tables and leaves every other drift for a human", () => {
		const missing = { kind: "missing", column: "SpanKind", expectedType: "String" } as const
		const extra = { kind: "extra", column: "Legacy", actualType: "String" } as const
		const mismatch = {
			kind: "type_mismatch",
			column: "Duration",
			expectedType: "UInt64",
			actualType: "Int64",
		} as const
		expect(columnDriftResolvedByApply("table", missing)).toBe(true)
		expect(columnDriftResolvedByApply("materialized_view", missing)).toBe(false)
		expect(columnDriftResolvedByApply("table", extra)).toBe(false)
		expect(columnDriftResolvedByApply("table", mismatch)).toBe(false)
	})
})
