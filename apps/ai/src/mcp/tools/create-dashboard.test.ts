import { describe, expect, it } from "vitest"
import { dataSourceQuerySet } from "@maple/widgets/dashboard"
import { buildSimpleWidgets, normalizeGroupBy } from "./create-dashboard"

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

describe("buildSimpleWidgets", () => {
	const cpu = {
		title: "Idle CPU by host",
		source: "metrics" as const,
		metric_name: "system.cpu.utilization",
		metric_type: "gauge" as const,
		group_by: "resource.host.name",
		where: 'attr.state = "idle"',
		unit: "percent",
	}

	it("accepts a resource.<key> group_by for metrics", () => {
		expect(typeof buildSimpleWidgets([cpu])).not.toBe("string")
		expect(buildSimpleWidgets([{ ...cpu, source: "logs" }])).toContain(
			'invalid group_by "resource.host.name"',
		)
	})

	it("AND-s a where clause with service_name into the query draft", () => {
		const widgets = buildSimpleWidgets([{ ...cpu, service_name: "node" }])
		const draft = typeof widgets === "string" ? undefined : dataSourceQuerySet(widgets[0]?.dataSource)
		expect(draft?.queries[0]?.whereClause).toBe('service.name = "node" AND attr.state = "idle"')
	})

	it("rejects a where clause on a list widget instead of dropping it", () => {
		const result = buildSimpleWidgets([
			{ title: "Recent logs", source: "logs", visualization: "list", where: 'attr.a = "1"' },
		])
		expect(result).toContain("where is not supported on list widgets")
	})
})
