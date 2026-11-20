import { Option, Record as Rec } from "effect"
import { describe, expect, it } from "vitest"
import {
	formatLe,
	labelValue,
	matchesAll,
	normalizeLabelName,
	seriesLabels,
	seriesMatchesAll,
	type StoredSeries,
} from "./labels"

const row = (overrides: Partial<StoredSeries> = {}): StoredSeries => ({
	promName: "http_server_request_duration_seconds_bucket",
	serviceName: "checkout",
	attributes: { "http.request.method": "GET", "http.response.status_code": "200" },
	resourceAttributes: {
		"service.name": "checkout",
		"service.namespace": "shop",
		"service.instance.id": "pod-1",
		"host.name": "node-a",
		"maple.org_id": "org_1",
		"telemetry.sdk.name": "opentelemetry",
		"process.command_line": "node server.js",
	},
	le: 0.5,
	...overrides,
})

describe("normalizeLabelName", () => {
	it("follows the Prometheus label name rules", () => {
		expect(normalizeLabelName("http.request.method")).toBe("http_request_method")
		expect(normalizeLabelName("a..b:c")).toBe("a_b_c")
		expect(normalizeLabelName("9lives")).toBe("_9lives")
	})
})

describe("formatLe", () => {
	it("formats bounds as Prometheus 3 does", () => {
		expect(formatLe(Infinity)).toBe("+Inf")
		expect(formatLe(0.5)).toBe("0.5")
		expect(formatLe(1)).toBe("1.0")
		expect(formatLe(100000)).toBe("100000.0")
		expect(formatLe(1e6)).toBe("1e+06")
		expect(formatLe(0.00001)).toBe("1e-05")
		expect(formatLe(0.0001)).toBe("0.0001")
	})
})

describe("seriesLabels", () => {
	it("merges datapoint and resource labels, with job, instance, __name__ and le", () => {
		expect(seriesLabels(row())).toEqual({
			__name__: "http_server_request_duration_seconds_bucket",
			host_name: "node-a",
			http_request_method: "GET",
			http_response_status_code: "200",
			instance: "pod-1",
			job: "shop/checkout",
			le: "0.5",
		})
	})

	it("lets datapoint attributes win over resource attributes, and exact keys over normalized ones", () => {
		const labels = seriesLabels(
			row({
				attributes: {
					"host.name": "dp-host",
					region: "eu",
					"region.x": "ignored",
					job: "node",
					instance: "10.0.0.1:9100",
				},
				resourceAttributes: { "host.name": "res-host", region: "us", "service.name": "api" },
				le: undefined,
			}),
		)
		expect(labels.host_name).toBe("dp-host")
		expect(labels.region).toBe("eu")
		expect(labels.job).toBe("node")
		expect(labels.instance).toBe("10.0.0.1:9100")
		expect(labels.le).toBeUndefined()
	})

	it("falls back to the ServiceName column for job and leaves instance out without an instance id", () => {
		const labels = seriesLabels(row({ resourceAttributes: {}, attributes: {}, le: undefined }))
		expect(labels).toEqual({ __name__: "http_server_request_duration_seconds_bucket", job: "checkout" })
	})

	it("treats an empty value as a missing label", () => {
		expect(labelValue(row({ attributes: { "host.name": "" } }), "host_name")).toBe("node-a")
		expect(labelValue(row(), "missing")).toBe("")
	})

	it("never promotes bookkeeping resource attributes", () => {
		const labels = seriesLabels(row())
		expect(labels).not.toHaveProperty("maple_org_id")
		expect(labels).not.toHaveProperty("telemetry_sdk_name")
		expect(labels).not.toHaveProperty("process_command_line")
	})
})

describe("prototype-named labels", () => {
	it("reads an attribute called constructor as its own string value", () => {
		const labels = seriesLabels(row({ attributes: { constructor: "x" } }))
		expect(Rec.get(labels, "constructor")).toEqual(Option.some("x"))
		expect(matchesAll(labels, [{ name: "constructor", op: "=", value: "x" }])).toBe(true)
	})

	it("matches a label named like an Object member as missing", () => {
		const labels = seriesLabels(row())
		expect(matchesAll(labels, [{ name: "constructor", op: "=", value: "" }])).toBe(true)
		expect(matchesAll(labels, [{ name: "toString", op: "!=", value: "" }])).toBe(false)
	})
})

describe("the service_name matcher alias", () => {
	const eq = (value: string) => [{ name: "service_name", op: "=" as const, value }]

	it("matches the service, without the namespace job carries, and never becomes a label", () => {
		const series = row()
		const labels = seriesLabels(series)
		expect(labels.service_name).toBeUndefined()
		expect(seriesMatchesAll(series, labels, eq("checkout"))).toBe(true)
		expect(seriesMatchesAll(series, labels, eq("shop/checkout"))).toBe(false)
	})

	it("falls back to the ServiceName column, and a real service_name attribute wins", () => {
		const bare = row({ resourceAttributes: {} })
		expect(seriesMatchesAll(bare, seriesLabels(bare), eq("checkout"))).toBe(true)
		const own = row({ attributes: { service_name: "billing" } })
		expect(seriesMatchesAll(own, seriesLabels(own), eq("billing"))).toBe(true)
		expect(seriesMatchesAll(own, seriesLabels(own), eq("checkout"))).toBe(false)
	})
})
