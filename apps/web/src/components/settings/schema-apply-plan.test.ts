import { describe, expect, it } from "vitest"
import { schemaApplyPlan } from "./schema-apply-plan"

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
		// The type mismatch on the same table is not something Apply resolves.
		expect(plan.leftAlone).toEqual(["traces"])
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
		expect(plan.leftAlone).toEqual(["errors_mv", "metrics_mv"])
	})
})
