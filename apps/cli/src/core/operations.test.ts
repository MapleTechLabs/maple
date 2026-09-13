import { describe, it } from "@effect/vitest"
import { strict as assert } from "node:assert"
import { Effect, Layer, Tracer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Mode } from "./mode"
import { rawQuery } from "./operations"

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

describe("rawQuery instrumentation", () => {
	it.effect("emits the canonical chDB Client span", () =>
		Effect.gen(function* () {
			// SAFETY: this focused fetch stub returns the only response shape exercised by the query.
			const request = (async () =>
				new Response(JSON.stringify([{ value: 1 }]), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch
			const { spans, tracer } = makeRecordingTracer()
			const modeLayer = Layer.succeed(Mode, {
				resolve: Effect.succeed({ _tag: "local" as const, baseUrl: "http://127.0.0.1:4318" }),
			})
			const httpLayer = FetchHttpClient.layer.pipe(
				Layer.provide(Layer.succeed(FetchHttpClient.Fetch, request)),
			)

			const rows = yield* rawQuery("SELECT 1").pipe(
				Effect.provide(Layer.merge(modeLayer, httpLayer)),
				Effect.withTracer(tracer),
			)

			assert.deepStrictEqual(rows, [{ value: 1 }])
			const span = spans.find((candidate) => candidate.name === "WarehouseExecutor.rawQuery")
			assert.ok(span)
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("db.system.name"), "clickhouse")
			assert.strictEqual(span.attributes.get("peer.service"), "chdb")
			assert.strictEqual(span.attributes.get("query.context"), "cli.rawQuery")
			assert.strictEqual(span.attributes.get("result.rowCount"), 1)
			assert.strictEqual(typeof span.attributes.get("db.duration_ms"), "number")
		}),
	)
})
