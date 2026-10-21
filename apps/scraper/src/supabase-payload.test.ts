import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { InternalScrapeTarget } from "@maple/domain/http"
import {
	convertFamiliesToOtlp,
	countDataPoints,
	countSamples,
	parsePrometheusText,
	splitExportRequest,
	type OtlpMetric,
} from "@maple/prometheus-otlp"
import { otlpContext } from "./Scraper"

// A live Supabase Management API metrics response (2026-10-21), project ref scrubbed.
const body = readFileSync(join(import.meta.dirname, "__fixtures__", "supabase-metrics.txt"), "utf8")
const REF = "abcdefghijklmnopqrst"

const TARGET = Schema.decodeUnknownSync(InternalScrapeTarget)({
	id: "22222222-2222-4222-8222-222222222222",
	orgId: "org_test",
	name: "Supabase app",
	serviceName: "supabase",
	targetType: "supabase",
	url: `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/metrics`,
	scrapeUrl: `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/metrics`,
	authHeaders: { Authorization: "Bearer sbp_oauth_test" },
	subTargetKey: null,
	scrapeIntervalSeconds: 60,
	labels: { "supabase.project.ref": REF, "supabase.project.name": "app" },
	ingestKey: "maple_pk_org",
})

/** The scraper's default `SCRAPER_OTLP_MAX_DATA_POINTS`. */
const DEFAULT_MAX_DATA_POINTS = 10_000

const dataPointsOf = (metric: OtlpMetric) => [
	...(metric.gauge?.dataPoints ?? []),
	...(metric.sum?.dataPoints ?? []),
	...(metric.histogram?.dataPoints ?? []),
]

describe("a Supabase project's metrics payload", () => {
	const parsed = parsePrometheusText(body)
	const converted = convertFamiliesToOtlp(parsed.families, otlpContext(TARGET, 1_792_599_480_000))

	it("parses every line of the exposition", () => {
		assert.strictEqual(parsed.skippedLineCount, 0)
		assert.strictEqual(parsed.families.length, 302)
		assert.strictEqual(countSamples(parsed.families), 624)
	})

	it("converts to OTLP, dropping only the NaN replication-lag gauges of a project without replicas", () => {
		assert.deepStrictEqual(converted.dataPointCounts, { sum: 161, gauge: 299, histogram: 9 })
		assert.strictEqual(converted.droppedSeriesCount, 3)
		const request = converted.request
		assert.isNotNull(request)
		if (request === null) return
		assert.strictEqual(countDataPoints(request), 469)
		// Well under the per-export cap, so one scrape ships as one request.
		assert.strictEqual(splitExportRequest(request, DEFAULT_MAX_DATA_POINTS).length, 1)
	})

	it("keeps the project ref, service type and target labels on every data point", () => {
		const metrics = converted.request?.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? []
		const points = metrics.flatMap(dataPointsOf)
		assert.strictEqual(points.length, 469)
		const serviceTypes = new Set<string>()
		points.forEach((point) => {
			const attributes = new Map(
				point.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]),
			)
			assert.strictEqual(attributes.get("supabase_project_ref"), REF)
			assert.strictEqual(attributes.get("supabase.project.ref"), REF)
			serviceTypes.add(attributes.get("service_type") ?? "missing")
		})
		assert.deepStrictEqual(serviceTypes, new Set(["db", "gotrue", "postgresql", "postgrest"]))
	})

	it("names the resource after the one supabase service, not the project", () => {
		const resource = converted.request?.resourceMetrics[0]?.resource.attributes ?? []
		assert.deepInclude(resource, { key: "service.name", value: { stringValue: "supabase" } })
	})
})
