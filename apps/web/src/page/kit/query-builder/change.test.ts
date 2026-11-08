import { createQueryDraft } from "@maple/query-engine/query-builder"
import { describe, expect, test } from "vitest"
import { switchDataSource } from "./change"

describe("switchDataSource", () => {
	const traces = { ...createQueryDraft(1), whereClause: "service.name = checkout AND root_only = true" }

	test("leaving traces drops root spans only and keeps the rest of the filter", () => {
		expect(switchDataSource(traces, "metrics").whereClause).toBe("service.name = checkout")
		expect(switchDataSource(traces, "logs").whereClause).toBe("service.name = checkout")
	})

	test("staying on traces keeps root spans only", () => {
		expect(switchDataSource(traces, "traces").whereClause).toBe(
			"service.name = checkout AND root_only = true",
		)
	})
})
