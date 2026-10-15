import { describe, expect, it } from "@effect/vitest"
import { GCP_METRIC_GROUPS } from "@maple/domain/gcp-metrics"
import { mapGcpTimeSeries } from "@maple/backend/services/integrations/gcp/mapping"
import type { MetricGaugeRow } from "@maple/backend/services/warehouse/metric-rows"
import { gcpTemplate } from "./gcp"

// What the poller stores under each curated name: one series per type carrying every label the
// table keeps, run through the poller's own mapping.
const STORED = new Map<string, { metricType: "sum" | "gauge"; rows: Array<MetricGaugeRow> }>()
for (const group of GCP_METRIC_GROUPS) {
	for (const metric of group.metrics) {
		const labels = (names: ReadonlyArray<string>) => Object.fromEntries(names.map((name) => [name, "x"]))
		const { sumRows, gaugeRows } = mapGcpTimeSeries({ group, metric, startMs: 0, endMs: 60_000 }, [
			{
				metric: { labels: labels([...group.resourceMetricLabels, ...metric.labels]) },
				resource: { labels: labels(["project_id", ...group.resourceLabels]) },
				points: [
					{
						interval: { endTime: new Date(60_000).toISOString() },
						value: {
							doubleValue: 1,
							distributionValue: {
								bucketOptions: { linearBuckets: { numFiniteBuckets: 1, width: 1 } },
								bucketCounts: ["0", "1", "0"],
							},
						},
					},
				],
			},
		])
		const rows = [...(STORED.get(metric.name)?.rows ?? []), ...sumRows, ...gaugeRows]
		STORED.set(metric.name, { metricType: sumRows.length > 0 ? "sum" : "gauge", rows })
	}
}

describe("Google Cloud dashboard template", () => {
	it("charts only metrics, attributes and quantiles the poller stores", () => {
		const { widgets } = gcpTemplate.build({ project_id: "acme-prod" })
		let checked = 0
		for (const widget of widgets) {
			if (widget.dataSource.kind !== "query") continue
			for (const query of widget.dataSource.queries) {
				if (query.dataSource !== "metrics") continue
				const stored = STORED.get(query.metricName)
				expect(stored, `${widget.id}: ${query.metricName} is not a curated metric`).toBeDefined()
				if (stored === undefined) continue
				expect(query.metricType, widget.id).toBe(stored.metricType)
				// A counter is a delta sum; summing a gauge would add up every minute of a bucket.
				expect(query.aggregation === "sum", widget.id).toBe(stored.metricType === "sum")
				// An attribute group-by keeps one service's value per group, so it only adds up
				// where every series shares the `gcp/<resource type>` service name.
				if (!query.groupBy.includes("service.name")) {
					expect(stored.rows[0]?.service_name, widget.id).toMatch(/^gcp\//)
				}

				const attributeKeys = stored.rows.flatMap((row) => Object.keys(row.metric_attributes))
				const resourceKeys = Object.keys(stored.rows[0]?.resource_attributes ?? {})
				for (const token of [...query.groupBy, ...query.whereClause.split(/\s+/)]) {
					if (token.startsWith("attr.")) {
						expect(attributeKeys, `${widget.id}: ${token}`).toContain(token.slice(5))
					}
					if (token.startsWith("resource.")) {
						expect(resourceKeys, `${widget.id}: ${token}`).toContain(token.slice(9))
					}
				}

				// A distribution is charted one quantile at a time: p50, p95 and p99 do not average.
				const quantile = /attr\.quantile = "([^"]+)"/.exec(query.whereClause)?.[1]
				if (attributeKeys.includes("quantile")) {
					expect(
						stored.rows.map((row) => row.metric_attributes.quantile),
						widget.id,
					).toContain(quantile)
				}
				checked += 1
			}
		}
		expect(checked).toBe(widgets.length)
	})

	it("lists every filter's values from stored gauges that carry the filtered attribute", () => {
		const { variables = [], widgets } = gcpTemplate.build({})
		for (const variable of variables) {
			const source = variable.type === "query" ? variable.source : undefined
			expect(source?.kind, variable.name).toBe("metric")
			if (source?.kind !== "metric") continue
			const { metricNames, metricType, scope, attributeKey } = source
			expect(scope, variable.name).toBe("resource")
			for (const name of metricNames) {
				const stored = STORED.get(name)
				expect(stored?.metricType, `${variable.name}: ${name}`).toBe(metricType)
				expect(
					Object.keys(stored?.rows[0]?.resource_attributes ?? {}),
					`${variable.name}: ${name}`,
				).toContain(attributeKey)
			}
		}

		// A widget filters on a variable only where its own series carry the attribute, so
		// picking a region never empties a chart of global resources.
		const declared = new Set(variables.map((variable) => variable.name))
		for (const widget of widgets) {
			if (widget.dataSource.kind !== "query") continue
			for (const query of widget.dataSource.queries) {
				for (const [, name] of query.whereClause.matchAll(/\$([A-Za-z]\w*)/g)) {
					expect(declared, `${widget.id}: $${name}`).toContain(name)
					const variable = variables.find((candidate) => candidate.name === name)
					if (variable?.type !== "query" || variable.source.kind !== "metric") continue
					if (query.dataSource !== "metrics") continue
					const stored = STORED.get(query.metricName)
					expect(
						Object.keys(stored?.rows[0]?.resource_attributes ?? {}),
						`${widget.id}: $${name}`,
					).toContain(variable.source.attributeKey)
				}
			}
		}
	})
})
