import { describe, expect, it } from "vitest"
import { isGcpMetricType } from "./gcp-live-metrics"

describe("isGcpMetricType", () => {
	it("reads Cloud Monitoring metric types as Google's", () => {
		for (const name of [
			"compute.googleapis.com/instance/cpu/utilization",
			"cloudsql.googleapis.com/database/postgresql/transaction_count",
			"kubernetes.io/container/cpu/core_usage_time",
			"istio.io/service/server/request_count",
			"knative.dev/serving/revision/request_count",
			"custom.googleapis.com/checkout/orders",
		]) {
			expect(isGcpMetricType(name), name).toBe(true)
		}
	})

	it("leaves OpenTelemetry and Prometheus names on the warehouse", () => {
		for (const name of [
			"app.kafka/consumer_lag",
			"http.server.request.duration",
			"gcp.cloudsql.cpu.utilization",
			"example.com/requests",
			"googleapis.com.evil/x",
			"process_cpu_seconds_total",
		]) {
			expect(isGcpMetricType(name), name).toBe(false)
		}
	})
})
