import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { ScraperEnv } from "./Env"
import { type RecordedRequest, stubFetch } from "./testing/stub-fetch"
import { httpConfig, MONITOR_A, MONITOR_B, mkUptimeTarget } from "./testing/uptime"
import { failed, succeeded } from "./UptimeProbe"
import { SPAN_FLUSH_INTERVAL, UptimeSpanExporter } from "./UptimeSpanExporter"
import { encodeTraceExport, type OtlpKeyValue, toOtlpSpan, type UptimeCheckSpan } from "./UptimeSpans"

const TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" }

const check = (overrides: Partial<UptimeCheckSpan> = {}): UptimeCheckSpan => ({
	ingestKey: "maple_pk_test",
	monitor: mkUptimeTarget(),
	trace: TRACE,
	startedAtMs: 1_761_436_800_000,
	endedAtMs: 1_761_436_800_120,
	outcome: succeeded(120, 200),
	...overrides,
})

const attrs = (list: ReadonlyArray<OtlpKeyValue>) => Object.fromEntries(list.map((kv) => [kv.key, kv.value]))

describe("toOtlpSpan", () => {
	it("an ok HTTP check is a CLIENT span with the traceparent ids and semconv attributes", () => {
		const span = toOtlpSpan(check())
		assert.deepStrictEqual(
			{
				traceId: span.traceId,
				spanId: span.spanId,
				name: span.name,
				kind: span.kind,
				start: span.startTimeUnixNano,
				end: span.endTimeUnixNano,
				status: span.status,
			},
			{
				traceId: TRACE.traceId,
				spanId: TRACE.spanId,
				name: "GET /checkout/health",
				kind: 3,
				start: "1761436800000000000",
				end: "1761436800120000000",
				status: { code: 1 },
			},
		)
		assert.deepStrictEqual(attrs(span.attributes), {
			"url.full": { stringValue: "https://api.example.com/checkout/health" },
			"http.request.method": { stringValue: "GET" },
			"server.address": { stringValue: "api.example.com" },
			"server.port": { intValue: "443" },
			"network.transport": { stringValue: "tcp" },
			"maple.uptime.kind": { stringValue: "http" },
			"maple.uptime.ok": { boolValue: true },
			"http.response.status_code": { intValue: "200" },
		})
	})

	it("a failed check is Error with the sentence as message, error.type and maple.uptime.failure", () => {
		const span = toOtlpSpan(check({ outcome: failed(30, "assertion", "Status 503, expected 2xx", 503) }))
		assert.deepStrictEqual(span.status, { code: 2, message: "Status 503, expected 2xx" })
		const attributes = attrs(span.attributes)
		assert.deepStrictEqual(attributes["error.type"], { stringValue: "assertion" })
		assert.deepStrictEqual(attributes["maple.uptime.failure"], {
			stringValue: "Status 503, expected 2xx",
		})
		assert.deepStrictEqual(attributes["maple.uptime.ok"], { boolValue: false })
	})

	it("records url.full without the query or fragment, which may carry credentials", () => {
		const monitor = mkUptimeTarget({
			config: httpConfig({ url: "https://api.example.com:8443/health?token=s3cret&x=1#frag" }),
		})
		const attributes = attrs(toOtlpSpan(check({ monitor })).attributes)
		assert.deepStrictEqual(attributes["url.full"], { stringValue: "https://api.example.com:8443/health" })
		assert.deepStrictEqual(attributes["server.port"], { intValue: "8443" })
	})

	it("names TCP and DNS checks by target", () => {
		const tcp = mkUptimeTarget({
			config: { _tag: "tcp", host: "db.example.com", port: 5432, timeoutMs: 5000 },
		})
		const dns = mkUptimeTarget({
			config: { _tag: "dns", hostname: "example.com", recordType: "MX", timeoutMs: 5000 },
		})
		assert.strictEqual(toOtlpSpan(check({ monitor: tcp })).name, "TCP db.example.com:5432")
		assert.strictEqual(toOtlpSpan(check({ monitor: dns })).name, "DNS MX example.com")
	})
})

describe("encodeTraceExport", () => {
	it("groups spans under one maple-uptime resource per monitor", () => {
		const unnamed = mkUptimeTarget({ id: MONITOR_B, name: "Status page", serviceName: null })
		const request = encodeTraceExport([check(), check({ monitor: unnamed }), check()])
		assert.lengthOf(request.resourceSpans, 2)
		const [first, second] = request.resourceSpans
		assert.deepStrictEqual(attrs(first!.resource.attributes), {
			"service.name": { stringValue: "maple-uptime" },
			"maple.uptime.monitor_id": { stringValue: MONITOR_A },
			"maple.uptime.monitor_name": { stringValue: "Checkout health" },
			"maple.uptime.service_name": { stringValue: "checkout" },
		})
		assert.lengthOf(first!.scopeSpans[0]!.spans, 2)
		assert.notProperty(attrs(second!.resource.attributes), "maple.uptime.service_name")
	})
})

describe("UptimeSpanExporter", () => {
	const env = {
		MAPLE_API_URL: "http://api.test",
		SD_INTERNAL_TOKEN: Redacted.make("token"),
		MAPLE_INGEST_URL: "http://ingest.test",
		SCRAPER_CONCURRENCY: 10,
		SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
		SCRAPER_OTLP_MAX_DATA_POINTS: 10_000,
		UPTIME_CONCURRENCY: 20,
		PORT: 0,
	}
	const exporterLayer = UptimeSpanExporter.layer.pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(ScraperEnv, env))),
	)

	it.effect("flushes one OTLP/JSON request per org per interval, with that org's key", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const fetch = stubFetch(recorded, () => new Response("{}", { status: 200 }))
			yield* Effect.gen(function* () {
				const exporter = yield* UptimeSpanExporter
				yield* exporter.record(check({ ingestKey: "maple_pk_one" }))
				yield* exporter.record(check({ ingestKey: "maple_pk_two" }))
				yield* exporter.record(check({ ingestKey: "maple_pk_one" }))
				const fiber = yield* Effect.forkChild(exporter.run)
				yield* TestClock.adjust(Duration.millis(0))

				assert.lengthOf(recorded, 2)
				const byKey = new Map(recorded.map((request) => [request.headers.authorization, request]))
				const one = byKey.get("Bearer maple_pk_one")
				assert.strictEqual(one?.url, "http://ingest.test/v1/traces")
				assert.strictEqual(one?.headers["content-type"], "application/json")
				const body: unknown = JSON.parse(one?.body ?? "null")
				assert.deepStrictEqual(
					body,
					JSON.parse(JSON.stringify(encodeTraceExport([check(), check()]))),
				)

				// Spans recorded after a flush wait for the next interval.
				yield* exporter.record(check())
				yield* TestClock.adjust(Duration.millis(Duration.toMillis(SPAN_FLUSH_INTERVAL) - 1))
				assert.lengthOf(recorded, 2)
				yield* TestClock.adjust(Duration.millis(1))
				assert.lengthOf(recorded, 3)
				yield* Fiber.interrupt(fiber)
			}).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))
		}).pipe(Effect.provide(exporterLayer)),
	)

	it.effect("drops spans an org cannot accept without failing the loop", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const fetch = stubFetch(recorded, () => new Response("over limit", { status: 402 }))
			yield* Effect.gen(function* () {
				const exporter = yield* UptimeSpanExporter
				yield* exporter.record(check())
				const fiber = yield* Effect.forkChild(exporter.run)
				yield* TestClock.adjust(Duration.millis(0))
				// A 402 is not transient: one request, no retry, nothing left pending.
				assert.lengthOf(recorded, 1)
				assert.strictEqual(yield* exporter.pending, 0)
				yield* exporter.record(check())
				yield* TestClock.adjust(SPAN_FLUSH_INTERVAL)
				assert.lengthOf(recorded, 2)
				yield* Fiber.interrupt(fiber)
			}).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))
		}).pipe(Effect.provide(exporterLayer)),
	)
})
