import { assert, describe, it, vi } from "@effect/vitest"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ISOLATE_AGE_HEADER, ISOLATE_ORDINAL_HEADER, IsolateAge } from "@maple/infra/isolate-age"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import * as Cloudflare from "@alchemy.run/cloudflare"
import type { HttpEffect } from "alchemy/Http"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import {
	Effect,
	Exit,
	Layer,
	Option,
	Ref,
	Schema,
	Scope,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { AuditEventsQueueProducer, MapleDbConnection } from "@maple/backend/platform/bindings"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { OrgId } from "@maple/domain/primitives"
import { runAfterResponse } from "@maple/backend/platform/after-response"
import { makeFetch } from "./http"

/** A stubbed fetch body as text: the client sends the JSON as bytes. */
const requestBodyText = (body: BodyInit | null | undefined): string =>
	typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : "{}"

/**
 * Requests the way alchemy's bridge runs them, with the SDK telemetry built into each event's
 * scope as `WorkerTelemetry` registers it, so the assertions read the exported server span.
 */
const ExportedSpan = Schema.Struct({
	name: Schema.String,
	kind: Schema.optionalKey(Schema.Finite),
	attributes: Schema.Array(
		Schema.Struct({ key: Schema.String, value: Schema.Record(Schema.String, Schema.Unknown) }),
	),
})
type ExportedSpan = typeof ExportedSpan.Type
/** OTLP `SPAN_KIND_SERVER`. Effect names server spans by method alone, so kind is what marks one. */
const SERVER_KIND = 2
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
	if (span === undefined) return undefined
	return Option.match(
		Arr.findFirst(span.attributes, (attribute) => attribute.key === key),
		{ onNone: () => undefined, onSome: ({ value }) => String(Rec.values(value)[0]) },
	)
}

/** The server spans the event exported, read off the OTLP requests the exporter sent. */
const capturedServerSpans = Effect.acquireRelease(
	Effect.sync(() =>
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 })),
	),
	(spy) => Effect.sync(() => spy.mockRestore()),
).pipe(
	Effect.map((spy) => () => {
		const traceCalls = Arr.filter(spy.mock.calls, ([input]) =>
			Str.endsWith("/v1/traces")(input instanceof Request ? input.url : input.toString()),
		)
		const resources = Arr.flatMap(
			traceCalls,
			([, init]) => decodeExportedTraces(JSON.parse(requestBodyText(init?.body))).resourceSpans ?? [],
		)
		const spans = Arr.flatMap(resources, (resource) =>
			Arr.flatMap(resource.scopeSpans, (scope) => scope.spans),
		)
		return Arr.filter(spans, (span) => span.kind === SERVER_KIND)
	}),
)

const event = (fetch: HttpEffect<RuntimeContext>, method: string, path: string) =>
	Effect.gen(function* () {
		const serverSpans = yield* capturedServerSpans
		const request = yield* Scope.make()
		const services = yield* Layer.buildWithScope(
			Layer.mergeAll(
				MapleCloudflareSDK.make(workerTelemetryConfig({ serviceName: "maple-ai" })).requestLayer.pipe(
					Layer.provide(Layer.succeed(MapleCloudflareSDK.WorkerEnvironment, env)),
				),
				Layer.succeed(Cloudflare.WorkerEnvironment, env),
			),
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
			// What maple-api reads back: its span is the one that sees cold-start CPU.
			headers: {
				ordinal: response.headers.get(ISOLATE_ORDINAL_HEADER) ?? undefined,
				ageMs: response.headers.get(ISOLATE_AGE_HEADER) ?? undefined,
			},
		}
	}).pipe(Effect.scoped)

class GraphBuildFailure extends Schema.TaggedError<GraphBuildFailure>()("GraphBuildFailure", {
	message: Schema.String,
}) {}

describe("the maple-ai Worker through alchemy's bridge", () => {
	it.effect("stamps isolate age on span and response, counting build failures but not liveness", () =>
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
				span: "GET",
				ordinal: undefined,
				ageMs: undefined,
				headers: { ordinal: undefined, ageMs: undefined },
			})
			assert.deepStrictEqual(first, {
				status: 200,
				span: "POST",
				ordinal: "1",
				ageMs: "0",
				headers: { ordinal: "1", ageMs: "0" },
			})
			assert.deepStrictEqual(failed, {
				status: 503,
				span: "POST",
				ordinal: "2",
				ageMs: "250",
				headers: { ordinal: "2", ageMs: "250" },
			})
		}).pipe(Effect.provide(IsolateAge.layer)),
	)
	it.effect(
		"hands a route's after-response work, like an audit write, to the event instead of running it first",
		() =>
			Effect.gen(function* () {
				const handedOver = yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([])
				const ran = yield* Ref.make(0)
				const fetch = yield* makeFetch(
					Effect.succeed(
						runAfterResponse(Ref.update(ran, (n) => n + 1)).pipe(
							Effect.as(HttpServerResponse.text("ok")),
						),
					),
					noPorts,
					undefined,
					Effect.succeed((work) => Ref.update(handedOver, (works) => [...works, work])),
				)
				const served = yield* event(fetch, "POST", "/mcp")
				const ranBeforeHandover = yield* Ref.get(ran)
				const works = yield* Ref.get(handedOver)
				yield* Effect.forEach(works, (work) => work, { discard: true })
				assert.deepStrictEqual(
					{
						status: served.status,
						ranBeforeHandover,
						handedOver: works.length,
						ran: yield* Ref.get(ran),
					},
					{ status: 200, ranBeforeHandover: 0, handedOver: 1, ran: 1 },
				)
			}).pipe(Effect.provide(IsolateAge.layer)),
	)

	/** An audited `/mcp` call through the real AuditLogService, with or without the queue producer. */
	const auditedCall = (withQueue: boolean) =>
		Effect.gen(function* () {
			const handedOver = yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([])
			const sent = yield* Ref.make(0)
			const ingested = yield* Ref.make(0)
			const warehouse = Layer.succeed(
				WarehouseQueryService,
				makeWarehouseServiceStub({ ingest: () => Ref.update(ingested, (n) => n + 1) }),
			)
			const producer = Layer.succeed(AuditEventsQueueProducer, {
				sendBatch: (messages) => Ref.update(sent, (n) => n + messages.length),
			})
			const audit = yield* Layer.build(
				Layer.effect(AuditLogService, AuditLogService.make).pipe(
					Layer.provide(withQueue ? Layer.merge(warehouse, producer) : warehouse),
				),
			)
			const handler = Effect.gen(function* () {
				const service = yield* AuditLogService
				yield* service.record({
					orgId: Schema.decodeSync(OrgId)("org_audit_wiring"),
					actor: { type: "api_key" },
					source: "mcp",
					action: "mcp_tool.called",
				})
				return HttpServerResponse.text("ok")
			}).pipe(Effect.provideContext(audit))
			const fetch = yield* makeFetch(
				Effect.succeed(handler),
				noPorts,
				undefined,
				Effect.succeed((work) => Ref.update(handedOver, (works) => [...works, work])),
			)
			yield* event(fetch, "POST", "/mcp")
			const atResponse = { sent: yield* Ref.get(sent), ingested: yield* Ref.get(ingested) }
			const works = yield* Ref.get(handedOver)
			yield* Effect.forEach(works, (work) => work, { discard: true })
			return {
				atResponse,
				handedOver: works.length,
				after: { sent: yield* Ref.get(sent), ingested: yield* Ref.get(ingested) },
			}
		}).pipe(Effect.scoped, Effect.provide(IsolateAge.layer))

	it.effect("sends an audited call's entry to the queue after the response when it has a producer", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* auditedCall(true), {
				atResponse: { sent: 0, ingested: 0 },
				handedOver: 1,
				after: { sent: 1, ingested: 0 },
			})
		}),
	)

	it.effect("writes an audited call's entry before the response when there is no producer", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* auditedCall(false), {
				atResponse: { sent: 0, ingested: 1 },
				handedOver: 0,
				after: { sent: 0, ingested: 1 },
			})
		}),
	)
})
