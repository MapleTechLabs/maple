import { Effect, Layer, Option, Redacted, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, it } from "vitest"
import { ScraperEnv, type ScraperEnvConfig } from "./Env"
import { OtlpIngest } from "./OtlpIngest"
import { telemetryLayer } from "./Telemetry"

const testEnv: ScraperEnvConfig = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("internal-token"),
	MAPLE_INGEST_URL: "http://ingest.test",
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	SCRAPER_OTLP_MAX_DATA_POINTS: 10_000,
	SCRAPER_OTLP_MAX_BODY_BYTES: 4 * 1024 * 1024,
	UPTIME_CONCURRENCY: 20,
	PORT: 0,
}

interface ExportedSpan {
	readonly name: string
	readonly kind: number
	readonly status: { readonly code: number }
	readonly events: ReadonlyArray<{ readonly name: string }>
	readonly attributes: ReadonlyArray<{
		readonly key: string
		readonly value: { readonly intValue?: unknown }
	}>
}

interface TracesBody {
	readonly resourceSpans: ReadonlyArray<{
		readonly resource: { readonly attributes: ReadonlyArray<{ readonly key: string }> }
		readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<ExportedSpan> }>
	}>
}

// The scraper's own telemetry export goes out through the global fetch.
const captureCollector = () => {
	const bodies: Array<TracesBody> = []
	const original = globalThis.fetch
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			if (
				Str.endsWith("/v1/traces")(input instanceof Request ? input.url : input.toString()) &&
				typeof init?.body === "string"
			) {
				bodies.push(JSON.parse(init.body))
			}
			return new Response(null, { status: 200 })
		},
		{ preconnect: original.preconnect },
	)
	return { bodies, restore: () => void (globalThis.fetch = original) }
}

const sampleRequest = {
	resourceMetrics: [
		{
			resource: { attributes: [] },
			scopeMetrics: [
				{
					scope: { name: "maple-prometheus-scraper" },
					metrics: [
						{
							name: "up",
							description: "",
							unit: "",
							gauge: {
								dataPoints: [
									{
										attributes: [],
										startTimeUnixNano: "0",
										timeUnixNano: "1",
										asDouble: 1,
									},
								],
							},
						},
					],
				},
			],
		},
	],
}

describe("scraper telemetry", () => {
	let restore: (() => void) | undefined
	afterEach(() => restore?.())

	it("exports a 402 from ingest as a non-error client span carrying the status", async () => {
		const collector = captureCollector()
		restore = collector.restore
		const ingest = OtlpIngest.layer.pipe(
			Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(ScraperEnv, testEnv))),
		)
		const blocked = Object.assign(async () => new Response("metrics limit reached", { status: 402 }), {
			preconnect: globalThis.fetch.preconnect,
		})

		await Effect.runPromise(
			Effect.gen(function* () {
				const otlp = yield* OtlpIngest
				yield* otlp.send("maple_pk_test_key", sampleRequest).pipe(Effect.ignore)
			}).pipe(
				Effect.provideService(FetchHttpClient.Fetch, blocked),
				// Closing the telemetry layer is the shutdown flush.
				Effect.provide(
					ingest.pipe(
						Layer.provideMerge(
							telemetryLayer({
								endpoint: "https://collector.test",
								ingestKey: "scraper-key",
								environment: "test",
								autoFlushInterval: false,
							}),
						),
					),
				),
			),
		)

		const spans = Arr.flatMap(collector.bodies, (body) =>
			Arr.flatMap(body.resourceSpans, (resource) =>
				Arr.flatMap(resource.scopeSpans, (scope) => scope.spans),
			),
		)
		const client = Option.getOrThrow(Arr.findFirst(spans, (span) => span.kind === 3 /* client */))
		expect(
			Option.map(
				Arr.findFirst(client.attributes, (a) => a.key === "http.response.status_code"),
				(a) => a.value.intValue,
			),
		).toEqual(Option.some(402))
		// A 402 is a billing block, not a fault: no Error span, so no error issue.
		expect(Arr.map(spans, (span) => span.status.code)).not.toContain(2 /* Error */)
		expect(Arr.flatMap(spans, (span) => Arr.map(span.events, (event) => event.name))).not.toContain(
			"exception",
		)
		expect(
			Arr.map(
				Arr.getUnsafe(Arr.getUnsafe(collector.bodies, 0)?.resourceSpans, 0)?.resource.attributes,
				(a) => a.key,
			),
		).toContain("vcs.repository.url.full")
	})
})
