import { createQueryDraft, resetQueryForDataSource } from "@maple/query-engine/query-builder"
import { describe, expect, test } from "vitest"
import type { QueryDraft } from "./draft"
import { init, Message, update, type PanelInputs } from "./panel"

describe("group-by picker", () => {
	// A widget opened from a saved dashboard has its fields in the draft but none in the
	// picker's own state; adding a field must keep the saved ones.
	test("adding a field to a loaded draft keeps its saved fields", () => {
		const base = resetQueryForDataSource(createQueryDraft(0), "metrics")
		const query: QueryDraft = {
			...base,
			groupBy: ["attr.namespace"],
			addOns: { ...base.addOns, groupBy: true },
		}
		const inputs: PanelInputs = {
			queryOf: (id) => (id === query.id ? query : undefined),
			baseValuesOf: () => ({}),
			orgId: "org_test",
			window: null,
		}
		const next = update(
			init("test"),
			Message.GotGroupByMessage({
				queryId: query.id,
				message: { _tag: "ClickedItem", value: "attr.job" },
			}),
			inputs,
		)
		const change = next.outMessage?._tag === "ChangedQuery" ? next.outMessage.change : null
		expect(change).toEqual({ _tag: "SetGroupBy", groupBy: ["attr.namespace", "attr.job"] })
	})
})

describe("metric picker", () => {
	test("a saved metric reads as its option label, never the name::type key", () => {
		const next = update(
			init("test"),
			Message.GotMetricMessage({
				queryId: "q",
				value: "process.cpu.utilization::gauge",
				message: { _tag: "HighlightedItem", index: null },
			}),
		)
		expect(next.model.metricPickers.q?.inputValue).toBe("process.cpu.utilization (gauge)")
	})
})
