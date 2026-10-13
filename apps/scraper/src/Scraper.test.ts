import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import { InternalScrapeTarget } from "@maple/domain/http"
import { convertFamiliesToOtlp, parsePrometheusText, type OtlpExportRequest } from "@maple/prometheus-otlp"
import { OtlpIngest } from "./OtlpIngest"
import { scrapeError, type ScrapeError } from "./ScrapeError"
import { otlpContext, Scraper } from "./Scraper"
import { TargetFetcher } from "./TargetFetcher"
import { endedSpansNamed, makeCapturingTracer } from "./testing/capturing-tracer"

const decodeTarget = Schema.decodeUnknownSync(InternalScrapeTarget)

const TARGET = decodeTarget({
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "org_test",
	name: "Node Exporter",
	serviceName: "node",
	targetType: "prometheus",
	url: "http://node.example.com:9100/metrics",
	scrapeUrl: "http://node.example.com:9100/metrics",
	authHeaders: {},
	subTargetKey: null,
	scrapeIntervalSeconds: 15,
	labels: { env: "prod" },
	ingestKey: "maple_pk_org",
})

interface Harness {
	readonly sent: Array<{ ingestKey: string; request: OtlpExportRequest }>
	fetch: () => Effect.Effect<string, ScrapeError>
	send: () => Effect.Effect<void, ScrapeError>
}

const makeHarness = (): Harness => ({
	sent: [],
	fetch: () => Effect.succeed("# TYPE up gauge\nup 1\n"),
	send: () => Effect.void,
})

const scraperLayer = (harness: Harness) =>
	Scraper.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(TargetFetcher, { fetch: () => Effect.suspend(() => harness.fetch()) }),
				Layer.succeed(OtlpIngest, {
					send: (ingestKey, request) =>
						Effect.suspend(() => {
							harness.sent.push({ ingestKey, request })
							return harness.send()
						}),
				}),
			),
		),
	)

const scrape = (harness: Harness) =>
	Effect.gen(function* () {
		const scraper = yield* Scraper
		return yield* scraper.scrape(TARGET)
	}).pipe(Effect.provide(scraperLayer(harness)))

describe("Scraper", () => {
	it.effect("exports one OTLP request with the org's ingest key and target attribution", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			const result = yield* scrape(harness)

			assert.deepStrictEqual(result, { samplesScraped: 1, samplesExported: 1 })
			assert.lengthOf(harness.sent, 1)
			assert.strictEqual(harness.sent[0]!.ingestKey, "maple_pk_org")
			const resource = harness.sent[0]!.request.resourceMetrics[0]!
			const attrs = Object.fromEntries(
				resource.resource.attributes.map((attr) => [attr.key, attr.value.stringValue]),
			)
			// Org attribution comes from the ingest key at the gateway, never the client.
			assert.deepStrictEqual(attrs, {
				"service.name": "node",
				maple_scrape_target_id: TARGET.id,
				maple_scrape_target_name: "Node Exporter",
			})
			assert.strictEqual(resource.scopeMetrics[0]!.scope.name, "maple-prometheus-scraper")
		}),
	)

	it.effect("skips the export entirely when a scrape yields no data points", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			harness.fetch = () => Effect.succeed("# only comments\n")
			const result = yield* scrape(harness)
			assert.deepStrictEqual(result, { samplesScraped: 0, samplesExported: 0 })
			assert.lengthOf(harness.sent, 0)
		}),
	)

	it.effect("names the target in the failure and closes the span as an error", () =>
		Effect.gen(function* () {
			const tracer = makeCapturingTracer()
			const harness = makeHarness()
			harness.fetch = () =>
				Effect.fail(
					scrapeError({ message: "returned HTTP 500", reason: "target_error", statusCode: 500 }),
				)
			const error = yield* scrape(harness).pipe(Effect.provide(tracer.layer), Effect.flip)

			assert.strictEqual(
				error.message,
				'target "Node Exporter" (node.example.com:9100) returned HTTP 500',
			)
			assert.strictEqual(error.reason, "target_error")
			assert.strictEqual(error.targetId, TARGET.id)
			assert.strictEqual(error.targetHost, "node.example.com:9100")

			const [span] = endedSpansNamed(tracer.ended, "scraper.scrape_target")
			assert.isTrue(Exit.isFailure(span!.exit))
			assert.strictEqual(span!.attributes.get("error.type"), "target_error")
			assert.strictEqual(span!.attributes.get("http.response.status_code"), 500)
			assert.strictEqual(span!.attributes.get("maple.scraper.target_host"), "node.example.com:9100")
		}),
	)

	// Only 5xx-class faults are `Error`: a blocked org used to mint an Error span
	// (and an error fingerprint) every interval, forever.
	it.effect("keeps the span Ok on a billing block but still fails the scrape", () =>
		Effect.gen(function* () {
			const tracer = makeCapturingTracer()
			const harness = makeHarness()
			harness.send = () =>
				Effect.fail(
					scrapeError({
						message: "ingest gateway rejected metrics: billing limit reached (HTTP 402)",
						reason: "delivery_blocked",
						statusCode: 402,
					}),
				)
			const error = yield* scrape(harness).pipe(Effect.provide(tracer.layer), Effect.flip)

			assert.strictEqual(error.reason, "delivery_blocked")
			const [span] = endedSpansNamed(tracer.ended, "scraper.scrape_target")
			assert.isTrue(Exit.isSuccess(span!.exit))
			assert.strictEqual(span!.attributes.get("error.type"), "delivery_blocked")
			assert.strictEqual(span!.attributes.get("http.response.status_code"), 402)
		}),
	)

	it.effect("turns a defect into a scrape_failed error instead of killing the loop", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			harness.fetch = () => Effect.die("parser exploded")
			const error = yield* scrape(harness).pipe(Effect.flip)
			assert.strictEqual(error.reason, "scrape_failed")
			assert.include(error.message, "parser exploded")
		}),
	)

	it.effect("starts a fresh trace instead of inheriting the caller's span", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			const traceIds: Array<string> = []
			harness.fetch = () =>
				Effect.map(Effect.currentSpan.pipe(Effect.orDie), (span) => {
					traceIds.push(span.traceId)
					return "up 1\n"
				})
			const outer = yield* Effect.makeSpan("test.outer")
			yield* scrape(harness).pipe(Effect.withParentSpan(outer))
			yield* scrape(harness).pipe(Effect.withParentSpan(outer))

			assert.lengthOf(new Set(traceIds), 2)
			for (const traceId of traceIds) assert.notStrictEqual(traceId, outer.traceId)
		}),
	)
})

describe("gateway contract fixture", () => {
	it("matches the fixture apps/ingest's scraper_contract Rust test deserializes", () => {
		const body = [
			"# HELP http_requests Total requests.",
			"# TYPE http_requests counter",
			'http_requests_total{code="200"} 100',
			"# TYPE up gauge",
			"up 1",
			"# TYPE lat histogram",
			'lat_bucket{le="0.1"} 1',
			'lat_bucket{le="+Inf"} 10',
			"lat_sum 42.5",
			"lat_count 10",
			"# TYPE rpc summary",
			'rpc{quantile="0.5"} 0.05',
			"rpc_sum 102.1",
			"rpc_count 800",
		].join("\n")

		const { request } = convertFamiliesToOtlp(
			parsePrometheusText(body).families,
			otlpContext(TARGET, 1750000000000),
		)
		const fixture: unknown = JSON.parse(
			readFileSync(join(import.meta.dirname, "__fixtures__", "otlp-export.json"), "utf8"),
		)

		// Changed the converter or `otlpContext` on purpose? Regenerate the fixture
		// AND re-run `cargo test scraper_contract` in apps/ingest.
		assert.deepStrictEqual(request, fixture)
	})
})
