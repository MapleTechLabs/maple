import type { LabelMatcher } from "@maple/promql"
import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import {
	type CatalogMetric,
	normalizeMetricName,
	promNamesOf,
	resolveSelectorName,
	unitSuffix,
} from "./names"

const eq = (value: string): LabelMatcher => ({ name: "__name__", op: "=", value })
const re = (value: string): LabelMatcher => ({ name: "__name__", op: "=~", value })

const metric = (overrides: Partial<CatalogMetric> & Pick<CatalogMetric, "metricName">): CatalogMetric => ({
	metricType: "gauge",
	isMonotonic: false,
	unit: "",
	...overrides,
})

const duration = metric({ metricName: "http.server.request.duration", metricType: "histogram", unit: "s" })
const cpuTime = metric({ metricName: "system.cpu.time", metricType: "sum", isMonotonic: true, unit: "s" })
const scraped = metric({ metricName: "node_cpu_seconds_total", metricType: "sum", isMonotonic: true })
const memory = metric({ metricName: "jvm.memory.used", unit: "By" })
const utilization = metric({ metricName: "system.cpu.utilization", unit: "1" })
const scrapedHistogram = metric({ metricName: "http_request_duration_seconds", metricType: "histogram" })
const expHistogram = metric({ metricName: "rpc.duration", metricType: "exponential_histogram", unit: "ms" })

const CATALOG = [duration, cpuTime, scraped, memory, utilization, scrapedHistogram, expHistogram]

const resolve = (...matchers: ReadonlyArray<LabelMatcher>) =>
	Arr.map(
		resolveSelectorName(matchers, CATALOG),
		(t) => `${t.table}:${t.metricName}:${t.component}:${t.promName}`,
	)

const promNames = (m: CatalogMetric) => Arr.map(promNamesOf(m), (n) => n.promName)

describe("normalizeMetricName", () => {
	it("replaces invalid characters, collapses and trims underscores, guards a leading digit", () => {
		expect(normalizeMetricName("http.server..request-duration_")).toBe("http_server_request_duration")
		expect(normalizeMetricName("2xx.count")).toBe("_2xx_count")
		expect(normalizeMetricName("ns:metric.name")).toBe("ns:metric_name")
	})
})

describe("unitSuffix", () => {
	it("translates OTel units", () => {
		expect(unitSuffix("s", "sum")).toEqual(["seconds"])
		expect(unitSuffix("KiBy", "gauge")).toEqual(["kibibytes"])
		expect(unitSuffix("{request}", "sum")).toEqual([])
		expect(unitSuffix("By/s", "gauge")).toEqual(["bytes", "per", "second"])
		expect(unitSuffix("{packets}/s", "gauge")).toEqual(["per", "second"])
		expect(unitSuffix("1", "gauge")).toEqual(["ratio"])
		expect(unitSuffix("1", "sum")).toEqual([])
	})
})

describe("promNamesOf", () => {
	it("names a histogram's series after its base with the unit", () => {
		expect(promNames(duration)).toContain("http_server_request_duration_seconds_bucket")
	})

	it("puts the canonical counter name first and keeps the stored name", () => {
		const names = promNames(cpuTime)
		expect(names[0]).toBe("system_cpu_time_seconds_total")
		expect(names).toContain("system.cpu.time")
	})

	it("does not repeat a unit or _total the scraped name already has", () => {
		expect(promNames(scraped)).toEqual(["node_cpu_seconds_total"])
	})
})

describe("resolveSelectorName", () => {
	it("resolves the translated histogram components", () => {
		expect(resolve(eq("http_server_request_duration_seconds_bucket"))).toEqual([
			"metrics_histogram:http.server.request.duration:bucket:http_server_request_duration_seconds_bucket",
		])
		expect(resolve(eq("http_server_request_duration_count"))).toEqual([
			"metrics_histogram:http.server.request.duration:count:http_server_request_duration_count",
		])
	})

	it("matches a scraped name exactly", () => {
		expect(resolve(eq("node_cpu_seconds_total"))).toEqual([
			"metrics_sum:node_cpu_seconds_total:value:node_cpu_seconds_total",
		])
		expect(resolve(eq("http_request_duration_seconds_bucket"))).toEqual([
			"metrics_histogram:http_request_duration_seconds:bucket:http_request_duration_seconds_bucket",
		])
	})

	it("resolves counters, units and ratios", () => {
		expect(resolve(eq("system_cpu_time_seconds_total"))).toEqual([
			"metrics_sum:system.cpu.time:value:system_cpu_time_seconds_total",
		])
		expect(resolve(eq("jvm_memory_used_bytes"))).toEqual([
			"metrics_gauge:jvm.memory.used:value:jvm_memory_used_bytes",
		])
		expect(resolve(eq("system_cpu_utilization_ratio"))).toEqual([
			"metrics_gauge:system.cpu.utilization:value:system_cpu_utilization_ratio",
		])
	})

	it("gives each stored metric and component one name, the first a regex accepts", () => {
		expect(resolve(re("system.*"))).toEqual([
			"metrics_sum:system.cpu.time:value:system_cpu_time_seconds_total",
			"metrics_gauge:system.cpu.utilization:value:system_cpu_utilization_ratio",
		])
	})

	it("anchors regexes and applies negative matchers", () => {
		expect(resolve(re("cpu"))).toEqual([])
		expect(
			resolve(re("rpc_duration_milliseconds_.*"), {
				name: "__name__",
				op: "!=",
				value: "rpc_duration_milliseconds_sum",
			}),
		).toEqual(["metrics_exponential_histogram:rpc.duration:count:rpc_duration_milliseconds_count"])
	})

	it("has no bucket series for an exponential histogram", () => {
		expect(resolve(re(".*_bucket"))).not.toContain(
			"metrics_exponential_histogram:rpc.duration:bucket:rpc_duration_milliseconds_bucket",
		)
		expect(resolve(re(".*_bucket"))).toHaveLength(2)
	})
})
