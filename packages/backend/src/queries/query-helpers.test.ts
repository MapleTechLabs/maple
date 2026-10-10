import { describe, expect, it } from "vitest"
import { nodeMetricSpec } from "./query-helpers"

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
