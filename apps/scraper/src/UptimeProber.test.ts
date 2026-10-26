import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { HostResolver } from "@maple/safe-fetch/dns"
import { endedSpansNamed, makeCapturingTracer } from "./testing/capturing-tracer"
import { type RecordedRequest, stubFetch } from "./testing/stub-fetch"
import { fixedResolver, mkUptimeTarget } from "./testing/uptime"
import { UptimeDnsProbe } from "./UptimeDnsProbe"
import { UptimeHttpProbe } from "./UptimeHttpProbe"
import { UptimeProber } from "./UptimeProber"
import { UptimeSpanExporter } from "./UptimeSpanExporter"
import { toOtlpSpan, type UptimeCheckSpan } from "./UptimeSpans"
import { UptimeTcpProbe } from "./UptimeTcpProbe"

const proberLayer = (exported: Array<UptimeCheckSpan>) =>
	UptimeProber.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				UptimeHttpProbe.layer,
				UptimeTcpProbe.layer,
				UptimeDnsProbe.layer,
				Layer.succeed(UptimeSpanExporter, {
					record: (span) => Effect.sync(() => void exported.push(span)),
					pending: Effect.succeed(0),
					run: Effect.never,
				}),
			),
		),
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(
			Layer.succeed(HostResolver, fixedResolver(new Map([["api.example.com", ["93.184.216.34"]]]))),
		),
	)

describe("UptimeProber", () => {
	it.effect("the target sees the same trace and span ids the exported span and the report carry", () =>
		Effect.gen(function* () {
			const exported: Array<UptimeCheckSpan> = []
			const recorded: Array<RecordedRequest> = []
			const tracer = makeCapturingTracer()
			const report = yield* Effect.gen(function* () {
				const prober = yield* UptimeProber
				return yield* prober.check(mkUptimeTarget())
			}).pipe(
				Effect.provide(proberLayer(exported)),
				Effect.provide(tracer.layer),
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => new Response("", { status: 503 })),
				),
			)

			const span = toOtlpSpan(exported[0]!)
			assert.match(span.traceId, /^[0-9a-f]{32}$/)
			assert.match(span.spanId, /^[0-9a-f]{16}$/)
			assert.strictEqual(recorded[0]?.headers.traceparent, `00-${span.traceId}-${span.spanId}-01`)
			assert.strictEqual(report.traceId, span.traceId)
			assert.deepStrictEqual(
				{ ok: report.ok, statusCode: report.statusCode, error: report.error },
				{ ok: false, statusCode: 503, error: "Status 503, expected 2xx" },
			)

			// The scraper's own span records the check without erroring: a down target is not our fault.
			const [self] = endedSpansNamed(tracer.ended, "uptime.check")
			assert.strictEqual(self?.attributes.get("maple.uptime.ok"), false)
			assert.strictEqual(self?.attributes.get("maple.uptime.kind"), "http")
			assert.strictEqual(self?.exit._tag, "Success")
		}),
	)
})
