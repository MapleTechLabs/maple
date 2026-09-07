import { assert, describe, it } from "@effect/vitest"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { env as workerEnv } from "../test/stubs/cloudflare-workers"
import { buildLayer } from "./scheduled"

/**
 * One cron fire the way alchemy's bridge runs it: the SDK telemetry is built
 * into the fire's scope exactly as `WorkerTelemetry` registers it, the tick
 * runs over its own layer graph inside that scope, and the scope closes after
 * the fire. What the SDK then POSTs is what production exports — so this pins
 * that `buildLayer` shadows neither the bridge's tracer nor its flush.
 */
const ExportedTraces = Schema.Struct({
	resourceSpans: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				resource: Schema.Struct({
					attributes: Schema.Array(
						Schema.Struct({
							key: Schema.String,
							value: Schema.Record(Schema.String, Schema.Unknown),
						}),
					),
				}),
				scopeSpans: Schema.Array(
					Schema.Struct({ spans: Schema.Array(Schema.Struct({ name: Schema.String })) }),
				),
			}),
		),
	),
})
const decodeExportedTraces = Schema.decodeUnknownSync(ExportedTraces)

interface RecordedRequest {
	readonly url: string
	readonly body: string | null
}

const stubFetch = (recorded: Array<RecordedRequest>): typeof globalThis.fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		recorded.push({
			url: input instanceof Request ? input.url : String(input),
			body: typeof init?.body === "string" ? init.body : null,
		})
		return new Response("{}", { status: 200 })
	}) as typeof globalThis.fetch

const telemetryEnv = { MAPLE_INGEST_KEY: "maple_sk_test", MAPLE_ENDPOINT: "http://ingest.test" }

const exportedTraces = (recorded: ReadonlyArray<RecordedRequest>) =>
	recorded
		.filter((request) => request.url.endsWith("/v1/traces"))
		.flatMap((request) => decodeExportedTraces(JSON.parse(request.body ?? "{}")).resourceSpans ?? [])

describe("alerting through alchemy's Worker bridge", () => {
	it.effect("a tick's span reaches the export when the fire's scope closes", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const realFetch = globalThis.fetch
			globalThis.fetch = stubFetch(recorded)
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					globalThis.fetch = realFetch
				}),
			)

			const fire = yield* Scope.make()
			const services = yield* Layer.buildWithScope(
				MapleCloudflareSDK.make(workerTelemetryConfig({ serviceName: "alerting" })).requestLayer.pipe(
					Layer.provide(Layer.succeed(MapleCloudflareSDK.WorkerEnvironment, telemetryEnv)),
				),
				fire,
			)
			// The shape of `runScheduled`: the tick graph provided around the tick,
			// under the event context the bridge hands the cron listener.
			yield* Effect.withSpan("alerting.scheduler_tick")(Effect.void).pipe(
				Effect.provide(buildLayer(workerEnv)),
				Effect.provide(services),
			)
			const flushedBeforeClose = recorded.length
			yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
			yield* Scope.close(fire, Exit.void)

			assert.strictEqual(flushedBeforeClose, 0)
			const resources = exportedTraces(recorded)
			const spans = resources.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
			assert.isTrue(spans.some((span) => span.name === "alerting.scheduler_tick"))
			const serviceName = resources[0]?.resource.attributes.find(
				(attribute) => attribute.key === "service.name",
			)?.value
			assert.deepStrictEqual(serviceName, { stringValue: "alerting" })
		}).pipe(Effect.scoped),
	)
})
