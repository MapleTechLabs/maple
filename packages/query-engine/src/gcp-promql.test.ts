import { GcpMetricDescriptor } from "@maple/domain/http"
import { describe, expect, it } from "vitest"
import { promQlChartRows, promQlRangeInput, promQlStarterQuery, promQlWidgetData } from "./gcp-promql"

const T0 = 1_760_000_000
const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

describe("promQlChartRows", () => {
	it("keys a single project's series by their labels without project_id", () => {
		const rows = promQlChartRows(
			[
				{
					labels: { service: "api", project_id: "shop" },
					points: [
						[T0, 1],
						[T0 + 60, 2],
					],
				},
				{ labels: { service: "web", project_id: "shop" }, points: [[T0, 3]] },
			],
			1,
		)

		expect(rows).toEqual([
			{ bucket: iso(T0), "service=api": 1, "service=web": 3 },
			// `web` has no point here: the key is absent rather than zero.
			{ bucket: iso(T0 + 60), "service=api": 2 },
		])
	})

	it("keeps project_id in the key when several projects answered", () => {
		const rows = promQlChartRows(
			[
				{ labels: { service: "api", project_id: "shop" }, points: [[T0, 1]] },
				{ labels: { service: "api", project_id: "shop-staging" }, points: [[T0, 2]] },
			],
			2,
		)

		expect(rows).toEqual([
			{ bucket: iso(T0), "project_id=shop, service=api": 1, "project_id=shop-staging, service=api": 2 },
		])
	})

	it("names series from the legend template and keeps colliding names apart", () => {
		const rows = promQlChartRows(
			[
				{ labels: { service: "api", region: "eu" }, points: [[T0, 1]] },
				{ labels: { service: "api", region: "us" }, points: [[T0, 2]] },
				{ labels: { region: "us" }, points: [[T0, 3]] },
			],
			1,
			"{{service}} requests",
		)

		expect(rows).toEqual([{ bucket: iso(T0), "api requests": 1, "api requests (2)": 2, " requests": 3 }])
	})

	it("keeps metrics_scope, which tells a scope's projects apart behind one answering project", () => {
		const rows = promQlChartRows(
			[
				{ labels: { metrics_scope: "shop-prod", service: "api" }, points: [[T0, 1]] },
				{ labels: { metrics_scope: "shop-staging", service: "api" }, points: [[T0, 2]] },
			],
			1,
		)

		expect(rows).toEqual([
			{
				bucket: iso(T0),
				"metrics_scope=shop-prod, service=api": 1,
				"metrics_scope=shop-staging, service=api": 2,
			},
		])
	})

	it("calls an aggregate with no labels left `value`, the field a stat reads", () => {
		const rows = promQlChartRows(
			[
				{
					labels: { __name__: "x", project_id: "shop" },
					points: [
						[T0 + 60, 5],
						[T0, 4],
					],
				},
			],
			1,
		)

		expect(rows).toEqual([
			{ bucket: iso(T0), value: 4 },
			{ bucket: iso(T0 + 60), value: 5 },
		])
	})
})

describe("promQlRangeInput", () => {
	it("trims the query and never asks Google for a step under a minute", () => {
		expect(
			promQlRangeInput(
				{ promql: "  up\n", projects: ["shop-prod"] },
				{ startTime: "2026-02-01 00:00:00", endTime: "2026-02-01 00:30:00" },
			),
		).toEqual({
			query: "up",
			startTime: "2026-02-01 00:00:00",
			endTime: "2026-02-01 00:30:00",
			stepSeconds: 60,
			projects: ["shop-prod"],
		})
		expect(
			promQlRangeInput(
				{ promql: "up" },
				{ startTime: "2026-02-01 00:00:00", endTime: "2026-02-08 00:00:00" },
			).stepSeconds,
		).toBe(3600)
	})
})

describe("promQlWidgetData", () => {
	const answer = {
		series: [{ labels: { project_id: "shop-prod" }, points: [[T0, 1]] as const }],
		projects: ["shop-prod"],
		failures: [{ scope: "projects/shop-staging", message: "Run the setup script again." }],
	}

	it("adds no notice to a complete answer", () => {
		expect(promQlWidgetData({ ...answer, failures: [] }, undefined, true)).toEqual({
			data: [{ bucket: iso(T0), value: 1 }],
		})
	})

	it("names each scope and its cause for members, and only a count on a share link", () => {
		expect(promQlWidgetData(answer, undefined, true).notice).toBe(
			"Partial result. projects/shop-staging: Run the setup script again.",
		)
		expect(promQlWidgetData(answer, undefined, false).notice).toBe(
			"Partial result: 1 Google Cloud scope could not be read.",
		)
	})
})

describe("promQlStarterQuery", () => {
	const descriptor = (fields: Partial<GcpMetricDescriptor>) =>
		new GcpMetricDescriptor({
			type: "run.googleapis.com/request_count",
			metricKind: "DELTA",
			valueType: "INT64",
			unit: "1",
			description: "",
			monitoredResourceTypes: ["cloud_run_revision"],
			labels: [{ key: "response_code_class", description: "" }],
			...fields,
		})

	it("rates a counter, grouped by its first label", () => {
		expect(promQlStarterQuery("run.googleapis.com/request_count", descriptor({}))).toBe(
			'sum by (project_id, response_code_class) (rate({"run.googleapis.com/request_count"}[5m]))',
		)
		expect(
			promQlStarterQuery(
				"run.googleapis.com/request_count",
				descriptor({ metricKind: "CUMULATIVE", labels: [] }),
			),
		).toBe('sum by (project_id) (rate({"run.googleapis.com/request_count"}[5m]))')
	})

	it("averages a gauge", () => {
		expect(
			promQlStarterQuery(
				"run.googleapis.com/container/instance_count",
				descriptor({ type: "run.googleapis.com/container/instance_count", metricKind: "GAUGE" }),
			),
		).toBe('avg by (project_id, response_code_class) ({"run.googleapis.com/container/instance_count"})')
	})

	it("takes the 95th percentile of a distribution and names the resource when there are several", () => {
		const latencies = descriptor({
			type: "run.googleapis.com/request_latencies",
			valueType: "DISTRIBUTION",
			monitoredResourceTypes: ["cloud_run_revision", "cloud_run_instance"],
		})

		expect(promQlStarterQuery("run.googleapis.com/request_latencies_bucket", latencies)).toBe(
			'histogram_quantile(0.95, sum by (project_id, le) (rate({"run.googleapis.com/request_latencies_bucket", monitored_resource="cloud_run_revision"}[5m])))',
		)
		// A distribution's `_count` is a counter like any other.
		expect(promQlStarterQuery("run.googleapis.com/request_latencies_count", latencies)).toBe(
			'sum by (project_id, response_code_class) (rate({"run.googleapis.com/request_latencies_count", monitored_resource="cloud_run_revision"}[5m]))',
		)
	})
})
