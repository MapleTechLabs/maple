import { assert, describe, it, vi } from "@effect/vitest"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { IsolateAge } from "@maple/infra/isolate-age"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import * as Cloudflare from "alchemy/Cloudflare"
import type { HttpEffect } from "alchemy/Http"
import { Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { MapleDbConnection } from "@maple/backend/platform/bindings"
import { makeFetch } from "./http"

/**
 * Requests the way alchemy's bridge runs them, with the SDK telemetry built into each event's
 * scope as `WorkerTelemetry` registers it, so the assertions read the exported server span.
 */
const ExportedSpan = Schema.Struct({
	name: Schema.String,
	attributes: Schema.Array(
		Schema.Struct({ key: Schema.String, value: Schema.Record(Schema.String, Schema.Unknown) }),
	),
})
type ExportedSpan = typeof ExportedSpan.Type
const decodeExportedTraces = Schema.decodeUnknownSync(
	Schema.Struct({
		resourceSpans: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(ExportedSpan) })),
				}),
			),
		),
	}),
)

const env = { MAPLE_INGEST_KEY: "maple_sk_test", MAPLE_ENDPOINT: "http://ingest.test" }
const noPorts = Layer.mergeAll(Layer.succeed(MapleDbConnection, Option.none()), workerEnvLayer(env))

/** One attribute as its rendered value; OTLP JSON carries ints as strings anyway. */
const attributeOf = (span: ExportedSpan | undefined, key: string): string | undefined => {
	const value = span?.attributes.find((attribute) => attribute.key === key)?.value
	return value === undefined ? undefined : String(Object.values(value)[0])
}

/** The server spans the event exported, read off the OTLP requests the exporter sent. */
const capturedServerSpans = Effect.acquireRelease(
	Effect.sync(() =>
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 })),
	),
	(spy) => Effect.sync(() => spy.mockRestore()),
).pipe(
	Effect.map(
		(spy) => () =>
			spy.mock.calls
				.filter(([input]) => String(input).endsWith("/v1/traces"))
				.flatMap(
					([, init]) =>
						decodeExportedTraces(JSON.parse(String(init?.body ?? "{}"))).resourceSpans ?? [],
				)
				.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
				.filter((span) => span.name.startsWith("http.server ")),
	),
)

const event = (fetch: HttpEffect, method: string, path: string) =>
	Effect.gen(function* () {
		const serverSpans = yield* capturedServerSpans
		const request = yield* Scope.make()
		const services = yield* Layer.buildWithScope(
			Layer.mergeAll(
				MapleCloudflareSDK.make(workerTelemetryConfig({ serviceName: "maple-ai" })).requestLayer,
				Layer.succeed(Cloudflare.WorkerEnvironment, env),
			).pipe(Layer.provide(Layer.succeed(MapleCloudflareSDK.WorkerEnvironment, env))),
			request,
		)
		// Alchemy erases this helper's return type to any. Restore its boundary contract.
		const fetchEvent:
			| Effect.Effect<Response, never, Scope.Scope | Cloudflare.WorkerEnvironment>
			| undefined = Cloudflare.Workers.makeRequestHandler(fetch)({
			kind: "Cloudflare.Workers.WorkerEvent",
			type: "fetch",
			input: new Request(`http://ai.maple.test${path}`, { method }),
		})
		assert.isDefined(fetchEvent)
		const response: Response = yield* fetchEvent.pipe(Effect.provide(services), Scope.provide(request))
		yield* Effect.promise(() => response.text())
		yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
		yield* Scope.close(request, Exit.void)
		const [server] = serverSpans()
		return {
			status: response.status,
			span: server?.name,
			ordinal: attributeOf(server, "maple.isolate.request_ordinal"),
			ageMs: attributeOf(server, "maple.isolate.age_ms"),
		}
	}).pipe(Effect.scoped)

class GraphBuildFailure extends Schema.TaggedError<GraphBuildFailure>()("GraphBuildFailure", {
	message: Schema.String,
}) {}

describe("the maple-ai Worker through alchemy's bridge", () => {
	it.effect("stamps isolate age on the server span, counting graph-build failures but not liveness", () =>
		Effect.gen(function* () {
			// Two handlers on one isolate: the counter is the isolate's, not the handler's.
			const serving = yield* makeFetch(
				Effect.succeed(Effect.succeed(HttpServerResponse.text("ok"))),
				noPorts,
			)
			const broken = yield* makeFetch(
				Effect.fail(new GraphBuildFailure({ message: "fixture" })),
				noPorts,
			)

			const health = yield* event(serving, "GET", "/health")
			yield* TestClock.adjust("100 millis")
			const first = yield* event(serving, "POST", "/mcp")
			yield* TestClock.adjust("250 millis")
			const failed = yield* event(broken, "POST", "/mcp")

			assert.deepStrictEqual(health, {
				status: 200,
				span: "http.server GET",
				ordinal: undefined,
				ageMs: undefined,
			})
			assert.deepStrictEqual(first, { status: 200, span: "http.server POST", ordinal: "1", ageMs: "0" })
			assert.deepStrictEqual(failed, {
				status: 503,
				span: "http.server POST",
				ordinal: "2",
				ageMs: "250",
			})
		}).pipe(Effect.provide(IsolateAge.layer)),
	)
})
