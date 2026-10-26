import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Exit, Fiber, Layer, Result, Schema, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import { InternalScrapeTarget } from "@maple/domain/http"
import { convertFamiliesToOtlp, parsePrometheusText, type OtlpExportRequest } from "@maple/prometheus-otlp"
import { OtlpIngest } from "./OtlpIngest"
import { scrapeError, type ScrapeError } from "./ScrapeError"
import { otlpContext, Scraper } from "./Scraper"
import { TargetFetcher } from "./TargetFetcher"
import type { TargetGroup } from "./TargetRegistry"
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
	fetch: (target: InternalScrapeTarget) => Effect.Effect<string, ScrapeError>
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
				Layer.succeed(TargetFetcher, {
					fetch: (target) => Effect.suspend(() => harness.fetch(target)),
				}),
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

const cycle = (harness: Harness, targets: TargetGroup) =>
	Effect.gen(function* () {
		const scraper = yield* Scraper
		return yield* scraper.scrapeCycle(targets, yield* Semaphore.make(10))
	}).pipe(Effect.provide(scraperLayer(harness)))

/** A one-target cycle, failing with that target's result. */
const scrape = (harness: Harness, target: InternalScrapeTarget = TARGET) =>
	Effect.flatMap(cycle(harness, [target]), (outcome) => Effect.fromResult(outcome.scrapes[0]!.result))

const branch = (key: string) =>
	decodeTarget({
		...TARGET,
		subTargetKey: key,
		url: `https://${key}.example.com/metrics`,
		scrapeUrl: `https://${key}.example.com/metrics`,
	})

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

	it.effect("stamps the target's pull source as maple_source_id", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			yield* scrape(harness, decodeTarget({ ...TARGET, sourceId: "src_abc" }))
			const attrs = Object.fromEntries(
				harness.sent[0]!.request.resourceMetrics[0]!.resource.attributes.map((attr) => [
					attr.key,
					attr.value.stringValue,
				]),
			)
			assert.strictEqual(attrs.maple_source_id, "src_abc")
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

	// A billing block is the ingest key's, so it fails every delivered sub-target.
	// Its span lives on `OtlpIngest.send`; the fetch spans stay Ok.
	it.effect("attributes a shared delivery failure to every delivered sub-target", () =>
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
			const outcome = yield* cycle(harness, [branch("main"), branch("dev")]).pipe(
				Effect.provide(tracer.layer),
			)

			assert.strictEqual(outcome.deliveryFailure?.reason, "delivery_blocked")
			const errors = outcome.scrapes.map((scrape) =>
				Result.isFailure(scrape.result) ? scrape.result.failure : null,
			)
			assert.deepStrictEqual(
				errors.map((error) => error?.reason),
				["delivery_blocked", "delivery_blocked"],
			)
			assert.deepStrictEqual(
				errors.map((error) => error?.targetHost),
				["main.example.com", "dev.example.com"],
			)
			for (const span of endedSpansNamed(tracer.ended, "scraper.scrape_target")) {
				assert.isTrue(Exit.isSuccess(span.exit))
			}
		}),
	)

	it.effect("delivers a whole parent cycle as one export with a resource per sub-target", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			const keys = Array.from({ length: 54 }, (_, index) => `branch-${index}`)
			const [first, ...rest] = keys.map(branch)
			const outcome = yield* cycle(harness, [first!, ...rest])

			assert.lengthOf(harness.sent, 1)
			const instances = harness.sent[0]!.request.resourceMetrics.map(
				(resource) =>
					resource.scopeMetrics[0]!.metrics[0]!.gauge!.dataPoints[0]!.attributes.find(
						(a) => a.key === "instance",
					)?.value.stringValue,
			)
			assert.deepStrictEqual(
				instances,
				keys.map((key) => `${key}.example.com`),
			)
			assert.deepStrictEqual(
				outcome.scrapes.map((scrape) => [
					scrape.target.subTargetKey,
					Result.isSuccess(scrape.result),
				]),
				keys.map((key) => [key, true]),
			)
		}),
	)

	it.effect("isolates a failing sub-target: the rest are delivered, it reports its own error", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			harness.fetch = (target) =>
				target.subTargetKey === "broken"
					? Effect.fail(
							scrapeError({
								message: "returned HTTP 503",
								reason: "rate_limited",
								statusCode: 503,
							}),
						)
					: Effect.succeed("up 1\n")
			const outcome = yield* cycle(harness, [branch("main"), branch("broken"), branch("dev")])

			assert.lengthOf(harness.sent, 1)
			assert.lengthOf(harness.sent[0]!.request.resourceMetrics, 2)
			assert.isNull(outcome.deliveryFailure)
			const byKey = new Map(
				outcome.scrapes.map((scrape) => [scrape.target.subTargetKey, scrape.result]),
			)
			assert.isTrue(Result.isSuccess(byKey.get("main")!))
			assert.isTrue(Result.isSuccess(byKey.get("dev")!))
			const broken = byKey.get("broken")!
			assert.isTrue(Result.isFailure(broken))
			if (Result.isFailure(broken)) assert.include(broken.failure.message, "broken.example.com")
		}),
	)

	// TARGET is a 15s target: a lone one may take 14s, a shared one gets 7.5s.
	it.effect("caps a stalled branch at half the interval only when it shares a cycle", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			harness.fetch = (target) =>
				target.subTargetKey === "dev"
					? Effect.as(Effect.sleep(Duration.seconds(10)), "up 1\n")
					: Effect.succeed("up 1\n")
			const shared = yield* Effect.forkChild(cycle(harness, [branch("main"), branch("dev")]))
			yield* TestClock.adjust(Duration.seconds(8))
			const outcome = yield* Fiber.join(shared)
			const dev = outcome.scrapes.find((scrape) => scrape.target.subTargetKey === "dev")!
			assert.isTrue(Result.isFailure(dev.result))
			if (Result.isFailure(dev.result)) assert.include(dev.result.failure.message, "request timed out")
			assert.strictEqual(dev.durationMs, 7_500)
			assert.lengthOf(harness.sent, 1)

			const lone = yield* Effect.forkChild(cycle(harness, [branch("dev")]))
			yield* TestClock.adjust(Duration.seconds(10))
			const loneOutcome = yield* Fiber.join(lone)
			assert.isTrue(Result.isSuccess(loneOutcome.scrapes[0]!.result))
			assert.strictEqual(loneOutcome.scrapes[0]!.durationMs, 10_000)
		}),
	)

	it.effect("sends nothing when every sub-target fails", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			harness.fetch = () => Effect.fail(scrapeError({ message: "down", reason: "target_error" }))
			const outcome = yield* cycle(harness, [branch("main"), branch("dev")])
			assert.lengthOf(harness.sent, 0)
			assert.isNull(outcome.deliveryFailure)
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

	it.effect("roots each cycle and parents its sub-target spans under it", () =>
		Effect.gen(function* () {
			const tracer = makeCapturingTracer()
			const harness = makeHarness()
			const outer = yield* Effect.makeSpan("test.outer")
			yield* cycle(harness, [branch("main"), branch("dev")]).pipe(
				Effect.withParentSpan(outer),
				Effect.provide(tracer.layer),
			)
			yield* cycle(harness, [branch("main")]).pipe(
				Effect.withParentSpan(outer),
				Effect.provide(tracer.layer),
			)

			const cycles = endedSpansNamed(tracer.ended, "scraper.scrape_cycle")
			assert.lengthOf(cycles, 2)
			for (const span of cycles) assert.isUndefined(span.parentSpanId)
			const targets = endedSpansNamed(tracer.ended, "scraper.scrape_target")
			assert.deepStrictEqual(
				targets.map((span) => span.parentSpanId),
				[cycles[0]!.spanId, cycles[0]!.spanId, cycles[1]!.spanId],
			)
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
