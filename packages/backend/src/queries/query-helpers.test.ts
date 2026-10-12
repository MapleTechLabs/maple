import { describe, expect, it } from "@effect/vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { CH } from "@maple/query-engine"
import { hostMetricSpec, nodeMetricSpec } from "./query-helpers"

const hostGaugeSql = (metric: "cpu" | "memory" | "filesystem") => {
	const spec = hostMetricSpec(metric)
	return compileUnsafe(
		CH.hostGaugeTimeseriesQuery({
			hostName: "h",
			metricName: spec.metricName,
			groupByAttributeKey: spec.groupByAttributeKey,
			attributeEquals: spec.attributeEquals,
		}),
		{
			orgId: OrgId.make("org_1"),
			startTime: "2024-01-01 00:00:00",
			endTime: "2024-01-02 00:00:00",
			bucketSeconds: 60,
		},
	).sql
}

describe("hostMetricSpec", () => {
	// Every mountpoint reports used, free and reserved rows; averaging them
	// shows each disk about a third full.
	it("reads filesystem utilization from the used state only", () => {
		const sql = hostGaugeSql("filesystem")
		expect(sql).toContain("Attributes['state'] = 'used'")
		expect(sql).toContain("Attributes['mountpoint']")
	})

	// CPU and memory chart every state as a stacked breakdown.
	it.each(["cpu", "memory"] as const)("keeps every %s state", (metric) => {
		expect(hostGaugeSql(metric)).not.toContain("Attributes['state'] =")
	})
})

describe("nodeMetricSpec", () => {
	it("maps utilization metrics to usage over k8s_cluster allocatable", () => {
		expect(nodeMetricSpec("cpu_utilization")).toEqual({
			metricName: "k8s.node.cpu.usage",
			capacityMetricName: "k8s.node.allocatable_cpu",
			unit: "percent",
		})
		expect(nodeMetricSpec("memory_utilization")).toEqual({
			metricName: "k8s.node.memory.working_set",
			capacityMetricName: "k8s.node.allocatable_memory",
			unit: "percent",
		})
	})

	it("leaves raw gauges without a capacity metric", () => {
		expect(nodeMetricSpec("memory_usage")).toEqual({
			metricName: "k8s.node.memory.working_set",
			unit: "bytes",
		})
		expect(nodeMetricSpec("cpu_usage")).toEqual({ metricName: "k8s.node.cpu.usage", unit: "cores" })
	})
})
