import { createQueryDraft, resetQueryForDataSource } from "@maple/query-engine/query-builder"
import { describe, expect, test } from "vitest"
import { applyQueryChange } from "../../kit/query-builder/change"
import { pickedMetric } from "./metric-options"

const OPTIONS = [
	{ value: "shop.orders.created::sum", label: "shop.orders.created (sum)", isMonotonic: true },
	{ value: "process.cpu.utilization::gauge", label: "process.cpu.utilization (gauge)", isMonotonic: false },
]

describe("metric picker", () => {
	test("a picked metric takes its monotonicity from the listed option and resets the aggregation", () => {
		const change = pickedMetric("shop.orders.created::sum", OPTIONS)
		expect(change).toEqual({ _tag: "SetMetric", metricName: "shop.orders.created", metricType: "sum", isMonotonic: true })
		const query = resetQueryForDataSource(createQueryDraft(0), "metrics")
		const picked = change === null ? query : applyQueryChange({ ...query, aggregation: "avg" }, change)
		expect(picked.dataSource === "metrics" ? picked.metricName : null).toBe("shop.orders.created")
		expect(picked.aggregation).not.toBe("avg")
	})

	test("a value that is not name::type picks nothing", () => {
		expect(pickedMetric("orders", OPTIONS)).toBeNull()
		expect(pickedMetric("orders::counter", OPTIONS)).toBeNull()
	})

	test("picking group-by fields turns the breakdown on, clearing them turns it off", () => {
		const query = resetQueryForDataSource(createQueryDraft(0), "metrics")
		const grouped = applyQueryChange(query, {
			_tag: "SetGroupBy",
			groupBy: ["attr.namespace", "resource.host.name"],
		})
		expect([grouped.groupBy, grouped.addOns.groupBy]).toEqual([["attr.namespace", "resource.host.name"], true])
		const off = applyQueryChange(grouped, { _tag: "SetGroupBy", groupBy: [] })
		expect([off.groupBy, off.addOns.groupBy]).toEqual([[], false])
	})

	test("the across select stores the space aggregation", () => {
		const query = resetQueryForDataSource(createQueryDraft(0), "metrics")
		const maxed = applyQueryChange(query, { _tag: "SetSpaceAggregation", aggregation: "max" })
		expect(maxed.dataSource === "metrics" ? maxed.spaceAggregation : null).toBe("max")
	})
})
