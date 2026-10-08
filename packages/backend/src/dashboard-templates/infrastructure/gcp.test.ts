import { describe, expect, it } from "@effect/vitest"
import { GCP_METRIC_GROUPS } from "@maple/domain/gcp-metrics"
import { mapGcpTimeSeries } from "@maple/backend/services/integrations/gcp/mapping"
import { gcpTemplate } from "./gcp"

// What the poller stores for each curated metric: one series carrying every label the table
// keeps, run through the poller's own mapping.
const STORED = new Map(
	GCP_METRIC_GROUPS.flatMap((group) =>
		group.metrics.map((metric) => {
			const labels = (names: ReadonlyArray<string>) =>
				Object.fromEntries(names.map((name) => [name, "x"]))
			const { sumRows, gaugeRows } = mapGcpTimeSeries({ group, metric, startMs: 0, endMs: 60_000 }, [
				{
					metric: { labels: labels(metric.labels) },
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
			return [
				metric.name,
				{ metricType: sumRows.length > 0 ? "sum" : "gauge", rows: [...sumRows, ...gaugeRows] },
			] as const
		}),
	),
)

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

				const attributeKeys = Object.keys(stored.rows[0]?.metric_attributes ?? {})
				const resourceKeys = Object.keys(stored.rows[0]?.resource_attributes ?? {})
				for (const token of [...query.groupBy, ...query.whereClause.split(/\s+/)]) {
					if (token.startsWith("attr.")) {
						expect(attributeKeys, `${widget.id}: ${token}`).toContain(token.slice(5))
					}
					if (token.startsWith("resource.")) {
						expect(resourceKeys, `${widget.id}: ${token}`).toContain(token.slice(9))
					}
				}

				const quantile = /attr\.quantile = "([^"]+)"/.exec(query.whereClause)?.[1]
				if (quantile !== undefined) {
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
})
